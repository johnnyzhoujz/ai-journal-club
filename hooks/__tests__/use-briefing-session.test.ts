// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBriefingSession } from "../use-briefing-session";

class MockMediaStreamTrack {
  kind = "audio";
  enabled = true;
  stop = vi.fn();
}

class MockMediaStream {
  private tracks: MockMediaStreamTrack[];

  constructor(tracks: MockMediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }

  addTrack(track: MockMediaStreamTrack) {
    this.tracks.push(track);
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.getTracks().filter((track) => track.kind === "audio");
  }
}

class MockRTCDataChannel {
  readyState: RTCDataChannelState = "connecting";
  sent: string[] = [];
  private listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>();

  addEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event | MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  send = vi.fn((data: string) => {
    this.sent.push(data);
  });

  close = vi.fn(() => {
    this.readyState = "closed";
    this.dispatch("close", new Event("close"));
  });

  open() {
    this.readyState = "open";
    this.dispatch("open", new Event("open"));
  }

  receive(payload: unknown) {
    this.dispatch(
      "message",
      {
        data: JSON.stringify(payload),
      } as MessageEvent,
    );
  }

  private dispatch(type: string, event: Event | MessageEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class MockRTCPeerConnection {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  dataChannel: MockRTCDataChannel | null = null;
  addedTracks: MockMediaStreamTrack[] = [];
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.dispatch("connectionstatechange", new Event("connectionstatechange"));
    this.dataChannel?.close();
  });

  private listeners = new Map<string, Set<(event: Event | RTCTrackEvent) => void>>();

  constructor() {
    peerConnections.push(this);
  }

  addEventListener(type: string, listener: (event: Event | RTCTrackEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  createDataChannel = vi.fn(() => {
    this.dataChannel = new MockRTCDataChannel();
    return this.dataChannel as unknown as RTCDataChannel;
  });

  addTrack = vi.fn((track: MockMediaStreamTrack) => {
    this.addedTracks.push(track);
    return {} as RTCRtpSender;
  });

  createOffer = vi.fn(async () => ({
    type: "offer",
    sdp: "offer-sdp",
  }));

  setLocalDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.localDescription = description;
    this.connectionState = "connecting";
  });

  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
    this.remoteDescription = description;
    this.connectionState = "connected";
  });

  emitTrack(track = new MockMediaStreamTrack()) {
    const stream = new MockMediaStream([track]) as unknown as MediaStream;
    this.dispatch(
      "track",
      {
        track,
        streams: [stream],
      } as unknown as RTCTrackEvent,
    );
  }

  setConnectionState(nextState: RTCPeerConnectionState) {
    this.connectionState = nextState;
    this.dispatch("connectionstatechange", new Event("connectionstatechange"));
  }

  private dispatch(type: string, event: Event | RTCTrackEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class MockAudioElement {
  autoplay = false;
  srcObject: MediaStream | null = null;
  play = vi.fn(() => audioPlayImplementation());
  pause = vi.fn();
  setAttribute = vi.fn();

  constructor() {
    audioElements.push(this);
  }
}

const peerConnections: MockRTCPeerConnection[] = [];
const audioElements: MockAudioElement[] = [];

let fetchMock: ReturnType<typeof vi.fn>;
let getUserMediaMock: ReturnType<typeof vi.fn>;
let audioPlayImplementation: () => Promise<void>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function getLatestPeerConnection() {
  const peer = peerConnections.at(-1);
  if (!peer) {
    throw new Error("Expected a peer connection to exist.");
  }

  return peer;
}

function getLatestDataChannel() {
  const dataChannel = getLatestPeerConnection().dataChannel;
  if (!dataChannel) {
    throw new Error("Expected a data channel to exist.");
  }

  return dataChannel;
}

function parseSentMessages(channel: MockRTCDataChannel) {
  return channel.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function startAndOpenSession({
  observabilityEnabled = false,
  compaction,
}: {
  observabilityEnabled?: boolean;
  compaction?: {
    enabled: boolean;
    triggerInputTokens: number;
    keepRecentItemCount: number;
    minDeleteItemCount: number;
  };
} = {}) {
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      answerSdp: "answer-sdp",
      briefingSessionId: "session-1",
      recommendedEndAt: "2026-04-14T12:00:00Z",
      observabilityEnabled,
      ...(compaction ? { compaction } : {}),
    }),
  );

  const hook = renderHook(() => useBriefingSession({ digestId: 123 }));

  await act(async () => {
    await hook.result.current.start();
  });

  await act(async () => {
    getLatestDataChannel().open();
  });

  return hook;
}

function traceRequestBodies() {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/briefing/trace")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

beforeEach(() => {
  peerConnections.length = 0;
  audioElements.length = 0;
  audioPlayImplementation = async () => {};

  fetchMock = vi.fn();
  getUserMediaMock = vi.fn(async () => {
    return new MockMediaStream([new MockMediaStreamTrack()]) as unknown as MediaStream;
  });

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal("MediaStream", MockMediaStream as unknown as typeof MediaStream);
  vi.stubGlobal("Audio", MockAudioElement as unknown as typeof Audio);

  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: getUserMediaMock,
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBriefingSession", () => {
  it("streams assistant transcript deltas and finalizes them on done", async () => {
    const hook = await startAndOpenSession();
    const channel = getLatestDataChannel();

    await act(async () => {
      channel.receive({
        type: "response.output_audio_transcript.delta",
        item_id: "assistant-1",
        delta: "Hello ",
      });
    });

    expect(hook.result.current.isAiSpeaking).toBe(true);
    expect(hook.result.current.transcriptItems).toEqual([
      expect.objectContaining({
        role: "assistant",
        itemId: "assistant-1",
        text: "Hello ",
        status: "streaming",
      }),
    ]);

    await act(async () => {
      channel.receive({
        type: "response.output_audio_transcript.done",
        item_id: "assistant-1",
        transcript: "Hello world",
      });
    });

    expect(hook.result.current.isAiSpeaking).toBe(false);
    expect(hook.result.current.transcriptItems).toEqual([
      expect.objectContaining({
        role: "assistant",
        itemId: "assistant-1",
        text: "Hello world",
        status: "complete",
      }),
    ]);
  });

  it("orders user transcript items by item relationships instead of arrival order", async () => {
    const hook = await startAndOpenSession();
    const channel = getLatestDataChannel();

    await act(async () => {
      channel.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-2",
        transcript: "Second question",
      });
      channel.receive({
        type: "conversation.item.created",
        previous_item_id: "user-1",
        item: {
          id: "user-2",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Second question" }],
        },
      });
      channel.receive({
        type: "conversation.item.created",
        previous_item_id: null,
        item: {
          id: "user-1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First question" }],
        },
      });
    });

    expect(hook.result.current.transcriptItems.map((item) => item.text)).toEqual([
      "First question",
      "Second question",
    ]);
  });

  it("uses typed fallback inside the same live session", async () => {
    const hook = await startAndOpenSession();
    const channel = getLatestDataChannel();

    expect(hook.result.current.canSendText).toBe(true);

    await act(async () => {
      channel.receive({
        type: "response.done",
        response: {
          id: "response-initial",
          status: "completed",
          output: [],
        },
      });
    });

    channel.sent.length = 0;

    await act(async () => {
      await hook.result.current.sendText("What changed?");
    });

    expect(parseSentMessages(channel)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What changed?" }],
        },
      },
      {
        type: "response.create",
      },
    ]);
  });

  it("requests microphone audio with local noise handling constraints", async () => {
    await startAndOpenSession();

    expect(getUserMediaMock).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });
  });

  it("starts tool requests during the preamble and waits for response.done before relaying output", async () => {
    await startAndOpenSession();
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        functionCallId: "call-1",
        output: {
          id: 123,
        },
      }),
    );

    await act(async () => {
      channel.receive({
        type: "response.function_call_arguments.delta",
        call_id: "call-1",
        response_id: "response-1",
        item_id: "tool-item-1",
        name: "get_digest_item",
        delta: '{"item_id":',
      });
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-1",
        response_id: "response-1",
        item_id: "tool-item-1",
        name: "get_digest_item",
        arguments: '{"item_id":123}',
      });
    });

    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/briefing/tool",
      expect.objectContaining({
        method: "POST",
      }),
    );

    expect(
      JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)),
    ).toEqual({
      briefingSessionId: "session-1",
      functionCallId: "call-1",
      toolName: "get_digest_item",
      arguments: {
        item_id: 123,
      },
    });

    expect(parseSentMessages(channel)).toEqual([]);

    await act(async () => {
      channel.receive({
        type: "response.done",
        response: {
          id: "response-1",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-1",
              name: "get_digest_item",
            },
          ],
        },
      });
    });

    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parseSentMessages(channel)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-1",
          output: JSON.stringify({ id: 123 }),
        },
      },
      {
        type: "response.create",
      },
    ]);
  });

  it("handles wait_for_user locally without hitting the server tool route", async () => {
    await startAndOpenSession();
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    await act(async () => {
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-wait",
        response_id: "response-wait",
        item_id: "tool-item-wait",
        name: "wait_for_user",
        arguments: "{}",
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-wait",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-wait",
              name: "wait_for_user",
            },
          ],
        },
      });
    });

    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parseSentMessages(channel)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-wait",
          output: JSON.stringify({ waited: true }),
        },
      },
    ]);
  });

  it("relays structured tool failures and deduplicates duplicate tool events", async () => {
    await startAndOpenSession();
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        functionCallId: "call-2",
        output: {
          error: "retrieval_failed",
          retryable: true,
        },
      }),
    );

    const relayFunctionCall = async () => {
      await act(async () => {
        channel.receive({
          type: "response.function_call_arguments.done",
          call_id: "call-2",
          response_id: "response-2",
          item_id: "tool-item-2",
          name: "search_archive",
          arguments: '{"query":"journal club"}',
        });
        channel.receive({
          type: "response.done",
          response: {
            id: "response-2",
            status: "completed",
            output: [
              {
                type: "function_call",
                call_id: "call-2",
                name: "search_archive",
              },
            ],
          },
        });
      });
      await flushAsyncWork();
    };

    await relayFunctionCall();
    await relayFunctionCall();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(parseSentMessages(channel)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-2",
          output: JSON.stringify({
            error: "retrieval_failed",
            retryable: true,
          }),
        },
      },
      {
        type: "response.create",
      },
    ]);
  });

  it("traces Realtime usage, phases, transcription usage, first-audio latency, and tool route latency", async () => {
    const hook = await startAndOpenSession({ observabilityEnabled: true });
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        functionCallId: "call-trace",
        output: {
          id: 123,
        },
      }),
    );

    await act(async () => {
      channel.receive({
        type: "input_audio_buffer.speech_started",
        item_id: "user-trace",
      });
      channel.receive({
        type: "input_audio_buffer.speech_stopped",
        item_id: "user-trace",
      });
      channel.receive({
        type: "input_audio_buffer.committed",
        item_id: "user-trace",
        previous_item_id: null,
      });
      channel.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-trace",
        transcript: "Tell me about item one.",
        usage: {
          total_tokens: 26,
          input_tokens: 17,
          output_tokens: 9,
        },
      });
      channel.receive({
        type: "response.created",
        response: {
          id: "response-trace",
          status: "in_progress",
        },
      });
      channel.receive({
        type: "response.output_audio_transcript.delta",
        response_id: "response-trace",
        item_id: "assistant-trace",
        delta: "I’ll check that.",
      });
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-trace",
        response_id: "response-trace",
        item_id: "tool-trace",
        name: "get_digest_item",
        arguments: '{"item_id":123}',
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-trace",
          status: "completed",
          usage: {
            total_tokens: 300,
            input_tokens: 200,
            output_tokens: 100,
            input_token_details: {
              cached_tokens: 50,
            },
          },
          output: [
            {
              type: "message",
              phase: "commentary",
              content: [{ type: "output_audio", transcript: "I’ll check that." }],
            },
            {
              type: "message",
              phase: "final_answer",
              content: [{ type: "output_audio", transcript: "Here is the detail." }],
            },
            {
              type: "function_call",
              call_id: "call-trace",
              name: "get_digest_item",
            },
          ],
        },
      });
    });
    await flushAsyncWork();

    await act(async () => {
      await hook.result.current.end();
    });

    const events = traceRequestBodies().flatMap((body) => body.events as unknown[]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "realtime.input.speech_started" }),
        expect.objectContaining({ eventType: "realtime.input.speech_stopped" }),
        expect.objectContaining({ eventType: "realtime.input.committed" }),
        expect.objectContaining({
          eventType: "realtime.transcription.completed",
          resultSummaryJson: {
            usage: expect.objectContaining({
              total_tokens: 26,
              input_tokens: 17,
              output_tokens: 9,
            }),
          },
        }),
        expect.objectContaining({ eventType: "realtime.response.created" }),
        expect.objectContaining({
          eventType: "realtime.response.first_audio_transcript_delta",
          latencyMs: expect.any(Number),
        }),
        expect.objectContaining({
          eventType: "response.done",
          resultSummaryJson: expect.objectContaining({
            usage: expect.objectContaining({
              total_tokens: 300,
              input_tokens: 200,
              output_tokens: 100,
              input_token_details: {
                cached_tokens: 50,
              },
            }),
            phase_summary: expect.objectContaining({
              commentary_count: 1,
              final_answer_count: 1,
              unknown_phase_count: 1,
              first_phase: "commentary",
              output_count: 3,
            }),
            function_call_count: 1,
          }),
        }),
        expect.objectContaining({
          eventType: "tool.result",
          functionCallId: "call-trace",
          latencyMs: expect.any(Number),
        }),
      ]),
    );
  });

  it("does not compact when compaction is disabled", async () => {
    await startAndOpenSession();
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    await act(async () => {
      for (let index = 1; index <= 4; index += 1) {
        channel.receive({
          type: "conversation.item.created",
          previous_item_id: index === 1 ? null : `user-${index - 1}`,
          item: {
            id: `user-${index}`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `Question ${index}` }],
          },
        });
      }
      channel.receive({
        type: "response.done",
        response: {
          id: "response-no-compact",
          status: "completed",
          usage: { input_tokens: 100_000 },
          output: [],
        },
      });
    });

    expect(parseSentMessages(channel)).toEqual([]);
  });

  it("compacts old confirmed records by inserting a summary before deleting, without removing visible transcript items", async () => {
    const hook = await startAndOpenSession({
      compaction: {
        enabled: true,
        triggerInputTokens: 10,
        keepRecentItemCount: 1,
        minDeleteItemCount: 2,
      },
    });
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    await act(async () => {
      for (let index = 1; index <= 4; index += 1) {
        channel.receive({
          type: "conversation.item.created",
          previous_item_id: index === 1 ? null : `user-${index - 1}`,
          item: {
            id: `user-${index}`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `Question ${index}` }],
          },
        });
      }
    });

    expect(hook.result.current.transcriptItems.map((item) => item.text)).toEqual([
      "Question 1",
      "Question 2",
      "Question 3",
      "Question 4",
    ]);

    await act(async () => {
      channel.receive({
        type: "response.done",
        response: {
          id: "response-compact",
          status: "completed",
          usage: { input_tokens: 11 },
          output: [],
        },
      });
    });

    let sentMessages = parseSentMessages(channel);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
      },
    });
    const summaryText = (
      ((sentMessages[0].item as Record<string, unknown>).content as Array<Record<string, unknown>>)[0]
        .text as string
    );
    expect(summaryText).toContain(
      "Summary of earlier briefing conversation for context:",
    );

    await act(async () => {
      channel.receive({
        type: "conversation.item.created",
        previous_item_id: "user-4",
        item: {
          id: "summary-1",
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: summaryText }],
        },
      });
      for (const itemId of ["user-1", "user-2", "user-3"]) {
        channel.receive({
          type: "conversation.item.deleted",
          item_id: itemId,
        });
      }
    });

    sentMessages = parseSentMessages(channel);
    expect(sentMessages.slice(1)).toEqual([
      {
        event_id: "briefing_compaction_delete_user-1",
        type: "conversation.item.delete",
        item_id: "user-1",
      },
      {
        event_id: "briefing_compaction_delete_user-2",
        type: "conversation.item.delete",
        item_id: "user-2",
      },
      {
        event_id: "briefing_compaction_delete_user-3",
        type: "conversation.item.delete",
        item_id: "user-3",
      },
    ]);
    expect(hook.result.current.transcriptItems.map((item) => item.text)).toEqual([
      "Question 1",
      "Question 2",
      "Question 3",
      "Question 4",
    ]);
  });

  it("does not delete compacted items if summary insertion fails", async () => {
    await startAndOpenSession({
      compaction: {
        enabled: true,
        triggerInputTokens: 10,
        keepRecentItemCount: 1,
        minDeleteItemCount: 2,
      },
    });
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    await act(async () => {
      for (let index = 1; index <= 3; index += 1) {
        channel.receive({
          type: "conversation.item.created",
          previous_item_id: index === 1 ? null : `old-${index - 1}`,
          item: {
            id: `old-${index}`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `Old question ${index}` }],
          },
        });
      }
      channel.receive({
        type: "response.done",
        response: {
          id: "response-compact-fail",
          status: "completed",
          usage: { input_tokens: 11 },
          output: [],
        },
      });
    });

    const [summaryCreate] = parseSentMessages(channel);
    expect(summaryCreate?.type).toBe("conversation.item.create");

    await act(async () => {
      channel.receive({
        type: "error",
        event_id: summaryCreate.event_id,
        code: "invalid_request_error",
        message: "summary rejected",
      });
    });

    expect(
      parseSentMessages(channel).filter(
        (message) => message.type === "conversation.item.delete",
      ),
    ).toEqual([]);
  });

  it("scopes runtime tool history to the current user turn", async () => {
    const hook = await startAndOpenSession({ observabilityEnabled: true });
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        functionCallId: "call-memory-empty",
        output: {
          results: [],
        },
      }),
    );

    await act(async () => {
      channel.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-1",
        transcript: "Have we seen browser agents?",
      });
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-memory-empty",
        response_id: "response-memory",
        item_id: "tool-memory",
        name: "search_memory",
        arguments: '{"query":"browser agents"}',
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-memory",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-memory-empty",
              name: "search_memory",
            },
          ],
        },
      });
    });
    await flushAsyncWork();

    await act(async () => {
      channel.receive({
        type: "response.done",
        response: {
          id: "response-after-memory",
          status: "completed",
          output: [],
        },
      });
    });
    channel.sent.length = 0;

    await act(async () => {
      await hook.result.current.sendText(
        "Search the archive for dosage liability updates.",
      );
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        functionCallId: "call-archive",
        output: {
          results: [],
        },
      }),
    );

    await act(async () => {
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-archive",
        response_id: "response-archive",
        item_id: "tool-archive",
        name: "search_archive",
        arguments: '{"query":"dosage liability updates"}',
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-archive",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-archive",
              name: "search_archive",
            },
          ],
        },
      });
    });
    await flushAsyncWork();

    const toolRequests = fetchMock.mock.calls
      .filter(([url]) => url === "/api/briefing/tool")
      .map(([, init]) => JSON.parse(String(init?.body)));

    expect(toolRequests).toEqual([
      expect.objectContaining({
        functionCallId: "call-memory-empty",
        toolName: "search_memory",
      }),
      expect.objectContaining({
        functionCallId: "call-archive",
        toolName: "search_archive",
        arguments: {
          query: "dosage liability updates",
        },
      }),
    ]);
  });

  it("clears stale user-turn eval context when transcription fails", async () => {
    await startAndOpenSession({ observabilityEnabled: true });
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    await act(async () => {
      channel.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "user-1",
        transcript: "Show me papers from April 2026.",
      });
      channel.receive({
        type: "conversation.item.input_audio_transcription.failed",
        item_id: "user-2",
      });
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        functionCallId: "call-after-failed-transcript",
        output: {
          results: [],
        },
      }),
    );

    await act(async () => {
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-after-failed-transcript",
        response_id: "response-after-failed-transcript",
        item_id: "tool-after-failed-transcript",
        name: "search_archive",
        arguments: '{"query":"funding rounds","before":"2026-05-01"}',
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-after-failed-transcript",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-after-failed-transcript",
              name: "search_archive",
            },
          ],
        },
      });
    });
    await flushAsyncWork();

    const toolRequest = fetchMock.mock.calls
      .filter(([url]) => url === "/api/briefing/tool")
      .map(([, init]) => JSON.parse(String(init?.body)))
      .find(
        (request) =>
          request.functionCallId === "call-after-failed-transcript",
      );

    expect(toolRequest).toMatchObject({
      toolName: "search_archive",
      arguments: {
        query: "funding rounds",
        before: "2026-05-01",
      },
    });
    expect(toolRequest.arguments).not.toHaveProperty("source");
  });

  it("surfaces stale_digest startup failures cleanly", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "stale_digest",
          latestDigestId: 456,
          latestDigestGeneratedAt: "2026-04-14T09:30:00Z",
        },
        409,
      ),
    );

    const hook = renderHook(() => useBriefingSession({ digestId: 123 }));

    await act(async () => {
      await hook.result.current.start();
    });

    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toEqual(
      expect.objectContaining({
        code: "stale_digest",
      }),
    );
    expect(hook.result.current.briefingSessionId).toBeNull();
    expect(hook.result.current.canSendText).toBe(false);
  });

  it("ends the session when the tool route reports session_expired", async () => {
    const hook = await startAndOpenSession();
    const channel = getLatestDataChannel();

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "session_expired",
        },
        410,
      ),
    );

    await act(async () => {
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-3",
        response_id: "response-3",
        item_id: "tool-item-3",
        name: "search_archive",
        arguments: '{"query":"briefing"}',
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-3",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-3",
              name: "search_archive",
            },
          ],
        },
      });
    });

    await flushAsyncWork();

    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toEqual(
      expect.objectContaining({
        code: "session_expired",
      }),
    );
    expect(hook.result.current.canSendText).toBe(false);
  });

  it("relays a tool failure instead of tearing down on invalid_arguments", async () => {
    const hook = await startAndOpenSession();
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "invalid_arguments",
        },
        400,
      ),
    );

    await act(async () => {
      channel.receive({
        type: "response.function_call_arguments.done",
        call_id: "call-bad",
        response_id: "response-bad",
        item_id: "tool-item-bad",
        name: "get_digest_item",
        arguments: '{"item_id":999}',
      });
      channel.receive({
        type: "response.done",
        response: {
          id: "response-bad",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call-bad",
              name: "get_digest_item",
            },
          ],
        },
      });
    });

    await flushAsyncWork();

    expect(hook.result.current.status).toBe("active");
    expect(hook.result.current.error).toBeNull();
    expect(parseSentMessages(channel)).toEqual([
      {
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: "call-bad",
          output: JSON.stringify({
            error: "retrieval_failed",
            retryable: true,
          }),
        },
      },
      {
        type: "response.create",
      },
    ]);
  });

  it("best-effort closes the server session on transport failure", async () => {
    const hook = await startAndOpenSession();
    const peerConnection = getLatestPeerConnection();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        closed: true,
        hangupAttempted: false,
        hangupSucceeded: null,
      }),
    );

    await act(async () => {
      peerConnection.setConnectionState("failed");
    });

    await flushAsyncWork();

    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.error).toEqual(
      expect.objectContaining({
        code: "transport_lost",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/briefing/end",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        body: JSON.stringify({
          briefingSessionId: "session-1",
        }),
      }),
    );
  });

  it("does not tear down on transient connectionState disconnected", async () => {
    const hook = await startAndOpenSession();
    const peerConnection = getLatestPeerConnection();

    await act(async () => {
      peerConnection.setConnectionState("disconnected");
    });

    await flushAsyncWork();

    expect(hook.result.current.status).toBe("active");
    expect(hook.result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cleans up a session returned after page teardown during startup", async () => {
    let resolveCallRoute!: (value: Response) => void;
    const pendingCallRoute = new Promise<Response>((resolve) => {
      resolveCallRoute = resolve;
    });

    fetchMock.mockReturnValueOnce(pendingCallRoute);

    const hook = renderHook(() => useBriefingSession({ digestId: 123 }));

    // Start triggers the call-route fetch which is now suspended.
    await act(async () => {
      void hook.result.current.start();
    });

    expect(hook.result.current.status).toBe("connecting");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Unmount simulates page teardown — runs cleanupSessionForPageTeardown.
    hook.unmount();

    // Now resolve the in-flight call-route fetch.
    await act(async () => {
      resolveCallRoute(
        new Response(
          JSON.stringify({
            answerSdp: "answer-sdp",
            briefingSessionId: "orphan-session",
            recommendedEndAt: "2026-04-14T12:00:00Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    });

    await flushAsyncWork();

    // The stale-run check should have fired bestEffortCloseSessionOnServer
    // for the orphaned session (keepalive fetch to /api/briefing/end).
    const endCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => call[0] === "/api/briefing/end",
    );
    expect(endCalls.length).toBe(1);
    expect(JSON.parse(String(endCalls[0][1]?.body))).toEqual({
      briefingSessionId: "orphan-session",
    });
  });

  it("does not block startup on a pending audio playback promise", async () => {
    audioPlayImplementation = () => new Promise(() => {});

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        answerSdp: "answer-sdp",
        briefingSessionId: "session-1",
        recommendedEndAt: "2026-04-14T12:00:00Z",
      }),
    );

    const hook = renderHook(() => useBriefingSession({ digestId: 123 }));

    await act(async () => {
      await hook.result.current.start();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/briefing/call",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(hook.result.current.status).toBe("connecting");

    await act(async () => {
      getLatestPeerConnection().emitTrack();
      getLatestDataChannel().open();
    });

    expect(audioElements.at(-1)?.play).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe("active");
    expect(hook.result.current.error).toBeNull();
  });

  it("sends response.cancel and output_audio_buffer.clear for manual stop", async () => {
    const hook = await startAndOpenSession();
    const channel = getLatestDataChannel();
    channel.sent.length = 0;

    await act(async () => {
      hook.result.current.stopCurrentResponse();
    });

    expect(parseSentMessages(channel)).toEqual([
      {
        type: "response.cancel",
      },
      {
        type: "output_audio_buffer.clear",
      },
    ]);
  });

  it("closes local resources and best-effort posts the end route on explicit end", async () => {
    const hook = await startAndOpenSession();
    const peerConnection = getLatestPeerConnection();
    const localTrack = peerConnection.addedTracks[0];

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        closed: true,
        hangupAttempted: false,
        hangupSucceeded: null,
      }),
    );

    await act(async () => {
      await hook.result.current.end();
    });

    expect(peerConnection.close).toHaveBeenCalled();
    expect(localTrack?.stop).toHaveBeenCalled();
    expect(hook.result.current.status).toBe("ended");
    expect(hook.result.current.error).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/briefing/end",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          briefingSessionId: "session-1",
        }),
      }),
    );
  });

  it("best-effort closes the server session on unmount cleanup", async () => {
    const hook = await startAndOpenSession();
    const peerConnection = getLatestPeerConnection();
    const localTrack = peerConnection.addedTracks[0];

    hook.unmount();

    expect(peerConnection.close).toHaveBeenCalled();
    expect(localTrack?.stop).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/briefing/end",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        body: JSON.stringify({
          briefingSessionId: "session-1",
        }),
      }),
    );
  });
});

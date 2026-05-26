import { describe, expect, it } from "vitest";

import {
  evaluateBriefingRuntimeToolCall,
  evaluateBriefingRuntimeToolResult,
  normalizeSearchArchiveSourceFromExactTitle,
} from "../briefing-runtime-evals";

describe("briefing runtime evals", () => {
  it("does not emit a missing_tool_preamble flag", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn: "Find the podcast where they discussed browser agents.",
      assistantTextBeforeTool: "",
      proposedToolCall: {
        functionCallId: "fc_1",
        toolName: "search_memory",
        arguments: { query: "browser agents", source: "all" },
      },
      previousToolCalls: [],
    });

    expect(result.flags.map((flag) => flag.ruleId)).not.toContain(
      "missing_tool_preamble",
    );
  });

  it("injects explicit source filters from the user turn", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn: "Find the podcast where they discussed browser agents.",
      assistantTextBeforeTool: "I will check the archive.",
      proposedToolCall: {
        functionCallId: "fc_1",
        toolName: "search_memory",
        arguments: { query: "browser agents", source: "all" },
      },
      previousToolCalls: [],
    });

    expect(result.correctedArgs).toMatchObject({ source: "podcast" });
    expect(result.flags.map((flag) => flag.ruleId)).toContain(
      "source_filter_injected",
    );
  });

  it("normalizes next-month exclusive before dates to the inclusive month end", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn: "Show me papers from April 2026.",
      assistantTextBeforeTool: "I will search papers.",
      proposedToolCall: {
        functionCallId: "fc_1",
        toolName: "search_archive",
        arguments: {
          query: "papers",
          source: "paper",
          after: "2026-04-01",
          before: "2026-05-01",
        },
      },
      previousToolCalls: [],
    });

    expect(result.correctedArgs).toMatchObject({ before: "2026-04-30" });
    expect(result.flags.map((flag) => flag.ruleId)).toContain(
      "month_before_normalized",
    );
  });

  it("infers archive source for one exact title match", () => {
    const corrected = normalizeSearchArchiveSourceFromExactTitle({
      args: { query: "The Browser Company" },
      archiveTitleSourceMatches: [
        {
          title: "The Browser Company",
          sourceType: "podcast",
        },
      ],
    });

    expect(corrected).toEqual({
      query: "The Browser Company",
      source: "podcast",
    });
  });

  it("blocks unnecessary get_memory_item when snippets are sufficient", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn: "What did we cover about Agent-World?",
      assistantTextBeforeTool: "I found the relevant memory.",
      proposedToolCall: {
        functionCallId: "fc_2",
        toolName: "get_memory_item",
        arguments: { memory_kind: "chunk", memory_id: 1182 },
      },
      previousToolCalls: [
        {
          functionCallId: "fc_1",
          toolName: "search_memory",
          arguments: { query: "Agent-World" },
          output: {
            results: [
              {
                kind: "chunk",
                id: 1182,
                snippet:
                  "Agent-World was described as a benchmark for stateful tool environments where agents perform multi-step tasks with persistent context.",
              },
            ],
          },
        },
      ],
    });

    expect(result.syntheticToolOutput).toMatchObject({
      skipped: true,
      reason: "search_memory_snippet_sufficient",
    });
    expect(result.flags[0]).toMatchObject({
      ruleId: "unnecessary_get_memory_item_blocked",
      action: "blocked_tool",
    });
  });

  it("allows get_memory_item for paper snippets", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn:
        "What does OpenSearch-VL contribute, and what is the specific training recipe?",
      assistantTextBeforeTool: "I found the relevant paper passage.",
      proposedToolCall: {
        functionCallId: "fc_2",
        toolName: "get_memory_item",
        arguments: { memory_kind: "chunk", memory_id: 7633 },
      },
      previousToolCalls: [
        {
          functionCallId: "fc_1",
          toolName: "search_memory",
          arguments: { query: "OpenSearch VL contribution training recipe" },
          output: {
            results: [
              {
                kind: "chunk",
                id: 7633,
                source_type: "paper",
                snippet:
                  "OpenSearch-VL is a fully open-source recipe for training frontier multimodal deep search agents with agentic reinforcement learning.",
              },
            ],
          },
        },
      ],
    });

    expect(result.syntheticToolOutput).toBeUndefined();
    expect(result.flags.map((flag) => flag.ruleId)).not.toContain(
      "unnecessary_get_memory_item_blocked",
    );
  });

  it("blocks get_memory_item when the id did not come from search_memory", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn:
        "What are the three core pillars in OpenSearch-VL?",
      assistantTextBeforeTool: "I found the paper record.",
      proposedToolCall: {
        functionCallId: "fc_2",
        toolName: "get_memory_item",
        arguments: { memory_kind: "chunk", memory_id: 5694 },
      },
      previousToolCalls: [
        {
          functionCallId: "fc_1",
          toolName: "search_archive",
          arguments: { query: "OpenSearch-VL", source: "paper" },
          output: {
            results: [
              {
                id: 5694,
                source_type: "paper",
                title: "OpenSearch-VL: An Open Recipe for Frontier Multimodal Search Agents",
              },
            ],
          },
        },
      ],
    });

    expect(result.syntheticToolOutput).toMatchObject({
      error: "memory_item_requires_search_memory_result",
      retryable: true,
    });
    expect(result.flags[0]).toMatchObject({
      ruleId: "get_memory_item_without_search_memory_result",
      action: "blocked_tool",
    });
  });

  it("blocks archive fallback after empty high-stakes memory search", () => {
    const result = evaluateBriefingRuntimeToolCall({
      currentUserTurn: "Did we cover recommended dosage for this clinical drug?",
      assistantTextBeforeTool: "I did not find support in memory.",
      proposedToolCall: {
        functionCallId: "fc_2",
        toolName: "search_archive",
        arguments: { query: "recommended dosage clinical drug" },
      },
      previousToolCalls: [
        {
          functionCallId: "fc_1",
          toolName: "search_memory",
          arguments: { query: "recommended dosage clinical drug" },
          output: { results: [] },
        },
      ],
    });

    expect(result.syntheticToolOutput).toMatchObject({
      blocked: true,
      reason: "high_stakes_memory_search_empty",
    });
  });

  it("nudges one rewritten memory retry before answering no", () => {
    const result = evaluateBriefingRuntimeToolResult({
      currentUserTurn: "Have we covered browser agents before?",
      toolCall: {
        functionCallId: "fc_1",
        toolName: "search_memory",
        arguments: { query: "browser agents" },
      },
      toolOutput: { results: [] },
      previousToolCalls: [],
    });

    expect(result.output).toMatchObject({
      results: [],
      guidance: expect.stringContaining("retry search_memory once"),
    });
    expect(result.flags[0]).toMatchObject({
      ruleId: "empty_memory_retry_nudge",
      action: "nudged",
    });
  });

  it("nudges first empty retries for have-we-seen wording", () => {
    const result = evaluateBriefingRuntimeToolResult({
      currentUserTurn: "Have we seen agentic browser benchmarks?",
      toolCall: {
        functionCallId: "fc_1",
        toolName: "search_memory",
        arguments: { query: "agentic browser benchmarks" },
      },
      toolOutput: { results: [] },
      previousToolCalls: [],
    });

    expect(result.output).toMatchObject({
      results: [],
      guidance: expect.stringContaining("retry search_memory once"),
    });
    expect(result.flags[0]).toMatchObject({
      ruleId: "empty_memory_retry_nudge",
      action: "nudged",
    });
  });

  it("nudges first empty retries for any-mentions wording", () => {
    const result = evaluateBriefingRuntimeToolResult({
      currentUserTurn: "Any mentions of SWE-bench verified?",
      toolCall: {
        functionCallId: "fc_1",
        toolName: "search_memory",
        arguments: { query: "SWE-bench verified" },
      },
      toolOutput: { results: [] },
      previousToolCalls: [],
    });

    expect(result.output).toMatchObject({
      results: [],
      guidance: expect.stringContaining("retry search_memory once"),
    });
    expect(result.flags[0]).toMatchObject({
      ruleId: "empty_memory_retry_nudge",
      action: "nudged",
    });
  });

  it.each([
    "Any references to SWE-bench verified?",
    "Any coverage on SWE-bench verified?",
  ])("nudges first empty retries for %s", (currentUserTurn) => {
    const result = evaluateBriefingRuntimeToolResult({
      currentUserTurn,
      toolCall: {
        functionCallId: "fc_1",
        toolName: "search_memory",
        arguments: { query: "SWE-bench verified" },
      },
      toolOutput: { results: [] },
      previousToolCalls: [],
    });

    expect(result.output).toMatchObject({
      results: [],
      guidance: expect.stringContaining("retry search_memory once"),
    });
    expect(result.flags[0]).toMatchObject({
      ruleId: "empty_memory_retry_nudge",
      action: "nudged",
    });
  });

  it("does not nudge a second empty memory retry", () => {
    const result = evaluateBriefingRuntimeToolResult({
      currentUserTurn: "Have we covered browser agents before?",
      toolCall: {
        functionCallId: "fc_2",
        toolName: "search_memory",
        arguments: { query: "browser agent benchmarks" },
      },
      toolOutput: { results: [] },
      previousToolCalls: [
        {
          functionCallId: "fc_1",
          toolName: "search_memory",
          arguments: { query: "browser agents" },
          output: { results: [] },
        },
      ],
    });

    expect(result.flags).toEqual([]);
    expect(result.output).toEqual({ results: [] });
  });

  it("does not nudge any-mentions wording after one empty memory result in history", () => {
    const result = evaluateBriefingRuntimeToolResult({
      currentUserTurn: "Any mentions of SWE-bench verified?",
      toolCall: {
        functionCallId: "fc_2",
        toolName: "search_memory",
        arguments: { query: "SWE-bench verified benchmark" },
      },
      toolOutput: { results: [] },
      previousToolCalls: [
        {
          functionCallId: "fc_1",
          toolName: "search_memory",
          arguments: { query: "SWE-bench verified" },
          output: { results: [] },
        },
      ],
    });

    expect(result.flags).toEqual([]);
    expect(result.output).toEqual({ results: [] });
  });
});

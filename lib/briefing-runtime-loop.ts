import {
  evaluateBriefingRuntimeToolCall,
  evaluateBriefingRuntimeToolResult,
  type ArchiveTitleSourceMatch,
  type BriefingRuntimeEvalFlag,
  type BriefingRuntimeToolCall,
  type BriefingRuntimeToolRecord,
} from "@/lib/briefing-runtime-evals";

export interface ApplyBriefingRuntimeToolCallOptions {
  currentUserTurn: string;
  assistantTextBeforeTool: string;
  proposedToolCall: BriefingRuntimeToolCall;
  previousToolCalls: BriefingRuntimeToolRecord[];
  archiveTitleSourceMatches?: ArchiveTitleSourceMatch[];
}

export interface AppliedBriefingRuntimeToolCall {
  flags: BriefingRuntimeEvalFlag[];
  effectiveToolCall: BriefingRuntimeToolCall;
  syntheticToolOutput?: unknown;
  completedRecord?: BriefingRuntimeToolRecord;
}

export interface ApplyBriefingRuntimeToolResultOptions {
  currentUserTurn: string;
  toolCall: BriefingRuntimeToolCall;
  toolOutput: unknown;
  previousToolCalls: BriefingRuntimeToolRecord[];
}

export interface AppliedBriefingRuntimeToolResult {
  flags: BriefingRuntimeEvalFlag[];
  output: unknown;
  completedRecord: BriefingRuntimeToolRecord;
}

export function applyBriefingRuntimeToolCall(
  options: ApplyBriefingRuntimeToolCallOptions,
): AppliedBriefingRuntimeToolCall {
  const evalResult = evaluateBriefingRuntimeToolCall(options);
  const effectiveToolCall = {
    ...options.proposedToolCall,
    arguments: evalResult.correctedArgs ?? options.proposedToolCall.arguments,
  };

  if (evalResult.syntheticToolOutput !== undefined) {
    return {
      flags: evalResult.flags,
      effectiveToolCall,
      syntheticToolOutput: evalResult.syntheticToolOutput,
      completedRecord: {
        functionCallId: effectiveToolCall.functionCallId,
        toolName: effectiveToolCall.toolName,
        arguments: effectiveToolCall.arguments,
        output: evalResult.syntheticToolOutput,
      },
    };
  }

  return {
    flags: evalResult.flags,
    effectiveToolCall,
  };
}

export function applyBriefingRuntimeToolResult(
  options: ApplyBriefingRuntimeToolResultOptions,
): AppliedBriefingRuntimeToolResult {
  const evalResult = evaluateBriefingRuntimeToolResult(options);

  return {
    flags: evalResult.flags,
    output: evalResult.output,
    completedRecord: {
      functionCallId: options.toolCall.functionCallId,
      toolName: options.toolCall.toolName,
      arguments: options.toolCall.arguments,
      output: evalResult.output,
    },
  };
}

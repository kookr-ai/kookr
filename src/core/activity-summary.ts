export type {
  ActivityDisclosure,
  ActivityItem,
  AgentMessage,
  PasteContentKind,
  SystemNotice,
  ToolCategory,
  ToolGroup,
  ToolGroupEntry,
  UserMessage,
  UserPasteBurst,
} from '../shared/contracts/activity-summary.js';

export {
  buildActivityDisclosure,
  categorizeTool,
  classifyPasteContent,
  compactToolSummary,
  PASTE_BURST_MIN_LINES,
  pasteBurstLabel,
  summarizeActivity,
  toolLabel,
} from '../shared/contracts/activity-summary.js';

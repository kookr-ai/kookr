export type {
  ActivityDisclosure,
  ActivityItem,
  AgentMessage,
  PasteContentKind,
  SystemNotice,
  ToolCategory,
  ToolGroup,
  ToolGroupEntry,
  UserInputDeliveryItem,
  UserMessage,
  UserPasteBurst,
} from '../shared/contracts/activity-summary.js';

export {
  buildActivityItems,
  buildActivityDisclosure,
  categorizeTool,
  classifyPasteContent,
  compactToolSummary,
  PASTE_BURST_MIN_LINES,
  pasteBurstLabel,
  summarizeActivity,
  toolLabel,
} from '../shared/contracts/activity-summary.js';

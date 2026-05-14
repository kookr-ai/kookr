export interface ProjectConfig {
  project: string;
  tracked?: boolean;
  dailyPrLimit?: number;
  weeklyPrLimit?: number;
  notes?: string;
  localPath?: string;
}

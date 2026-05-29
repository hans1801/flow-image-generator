export type PromptStatus = 'PENDING' | 'IN_PROGRESS' | 'DOWNLOADED' | 'ERROR' | 'RATE_LIMITED';

export interface QueueItem {
  id: string;
  scene_number: number;
  prompt: string;
  status: PromptStatus;
}

export interface ImagePrompt {
  subjects: { description: string; action: string }[];
  environment: string;
  lighting: string;
  composition: string;
  style: string;
}

export interface ScriptScene {
  scene_number: number;
  image_prompt: ImagePrompt;
  narration: string;
}

export interface ScriptData {
  scenes: ScriptScene[];
}

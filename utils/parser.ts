import { ImagePrompt } from './types';

export function parseImagePromptToText(prompt: ImagePrompt): string {
  const subjects = prompt.subjects.map(s => `${s.description} ${s.action}`).join(', ');
  
  return `Subjects: ${subjects}.
Environment: ${prompt.environment}
Lighting: ${prompt.lighting}
Composition: ${prompt.composition}
Style: ${prompt.style}`.trim();
}

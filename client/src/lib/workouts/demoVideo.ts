/**
 * "Watch a demo" on every How-to panel (owner, 2026-10-23): a YouTube search
 * for the exercise's name plus "proper form". A search rather than a chosen
 * video, so it never goes stale and needs nothing stored; the written steps
 * stay beside it as the backup.
 */
export function demoVideoUrl(exerciseName: string): string {
  const name = exerciseName.trim().replace(/\s+/g, ' ');
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${name} proper form`)}`;
}

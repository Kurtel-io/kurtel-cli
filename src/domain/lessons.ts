// Lesson metadata found in stores written by earlier versions: still read and validated, never created.
export interface LessonQuote { event_id: string; quote: string }
export interface LessonDetails {
  error_event_id: string;
  failure: LessonQuote;
  approach: LessonQuote;
  trigger: { files: string[]; symbols: string[]; task_type: "edit" };
  success_event_id: string;
  resolution: "test_passed" | "user_confirmed";
  author: string | null;
  visibility: "local_profile";
  session_id: string;
}

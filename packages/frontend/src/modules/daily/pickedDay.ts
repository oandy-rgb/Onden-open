// The day the journal page shows, kept while a note is open: opening a note
// leaves the page, and coming back lands on the same day, not on today. It
// lasts for the session and only for the day it was picked on (a new "today"
// starts from today again).

let picked: { date: string; today: string } | null = null;

export function pickedDay(today: string): string {
  return picked && picked.today === today ? picked.date : today;
}

export function rememberPickedDay(date: string, today: string): void {
  picked = date === today ? null : { date, today };
}

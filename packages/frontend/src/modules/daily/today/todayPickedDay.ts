// The day the 今天 page shows, kept while a note is open from it (opening a note leaves the page; coming back lands on
// the same day). Its own, not the Journal page's (daily/pickedDay): picking a day here must not move the Journal page.
// Lasts for the session and only for the day it was picked on (a new "today" starts from today again).

let picked: { date: string; today: string } | null = null;

export function todayPickedDay(today: string): string {
  return picked && picked.today === today ? picked.date : today;
}

export function rememberTodayPickedDay(date: string, today: string): void {
  picked = date === today ? null : { date, today };
}

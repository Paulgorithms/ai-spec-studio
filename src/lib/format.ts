// Formats dates the same way on every server and in every build ("Nov 6,
// 2026"): a fixed locale and UTC, rather than the machine's settings, so
// prerendered HTML never depends on where it was built.
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

// "1 specification", "4 specifications".
export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

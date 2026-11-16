// Which Drizzle Kit commands work offline. drizzle.config.ts loads database
// credentials only for the others. Pure and import-free: Drizzle Kit loads
// this through drizzle.config.ts, outside Next.js.

// Commands that only read the schema and the drizzle/ folder (drizzle-kit
// 0.31): they never connect, so they get no credentials.
const OFFLINE_COMMANDS = new Set(["generate", "check", "up", "drop", "export"]);

// Commands that connect (migrate, push, pull/introspect, studio), named in
// messages. Anything else is reported as "this command".
const KNOWN_COMMANDS = new Set([
  ...OFFLINE_COMMANDS,
  "migrate",
  "push",
  "pull",
  "introspect",
  "studio",
]);

// Drizzle Kit runs as `node .../bin.cjs <command> [flags]`, so the command is
// argv[2]. A missing or unrecognized command counts as needing the database,
// which fails closed: it must then have valid migration credentials.
export function drizzleKitCommand(argv: readonly string[]): string {
  const command = argv[2];
  return command && KNOWN_COMMANDS.has(command) ? command : "this command";
}

export function drizzleKitNeedsDatabase(argv: readonly string[]): boolean {
  return !OFFLINE_COMMANDS.has(argv[2] ?? "");
}

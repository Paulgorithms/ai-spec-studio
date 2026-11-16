import { describe, expect, test } from "vitest";
import {
  drizzleKitCommand,
  drizzleKitNeedsDatabase,
} from "@/lib/db/drizzle-kit-command";

const argv = (...args: string[]) => [
  "/usr/bin/node",
  "/x/drizzle-kit/bin.cjs",
  ...args,
];

describe("drizzleKitNeedsDatabase", () => {
  test.each(["generate", "check", "up", "drop", "export"])(
    "%s is offline: no credentials are loaded",
    (command) => {
      expect(drizzleKitNeedsDatabase(argv(command, "--name", "x"))).toBe(false);
    },
  );

  test.each(["migrate", "push", "pull", "introspect", "studio"])(
    "%s connects, so it needs credentials",
    (command) => {
      expect(drizzleKitNeedsDatabase(argv(command))).toBe(true);
    },
  );

  test.each([
    ["no command", argv()],
    ["a flag first", argv("--config", "drizzle.config.ts", "generate")],
    ["an unknown command", argv("generat")],
    ["different case", argv("Generate")],
  ])("fails closed with %s", (_, args) => {
    expect(drizzleKitNeedsDatabase(args)).toBe(true);
  });
});

describe("drizzleKitCommand", () => {
  test("names known commands", () => {
    expect(drizzleKitCommand(argv("migrate"))).toBe("migrate");
  });

  test("never echoes an unknown argument", () => {
    expect(drizzleKitCommand(argv("FakeSecret-value"))).toBe("this command");
    expect(drizzleKitCommand(argv())).toBe("this command");
  });
});

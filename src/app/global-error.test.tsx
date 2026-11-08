import { act, waitFor } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from "@/lib/theme";
import GlobalError from "./global-error";

// When the root layout fails during server rendering, global-error.tsx is the
// whole server HTML: the layout's <head> theme script isn't there. This test
// puts that HTML in the document the way the browser parses it, then hydrates
// it, to check that a saved light theme is restored and nothing mismatches.

const element = <GlobalError error={new Error("boom")} retry={() => {}} />;
let root: Root | undefined;

function loadServerHtml() {
  const html = renderToString(element);
  const htmlTag = html.match(/^<html([^>]*)>/)?.[1] ?? "";
  const head = html.match(/<head>([\s\S]*)<\/head>/)?.[1] ?? "";
  const bodyTag = html.match(/<body([^>]*)>/)?.[1] ?? "";
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
  const attributes = (tag: string) =>
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
      name,
      value,
    ]);

  const documentElement = document.documentElement;
  for (const name of documentElement.getAttributeNames()) {
    documentElement.removeAttribute(name);
  }
  for (const [name, value] of attributes(htmlTag)) {
    documentElement.setAttribute(name, value);
  }
  document.head.innerHTML = head;
  for (const [name, value] of attributes(bodyTag)) {
    document.body.setAttribute(name, value);
  }
  document.body.innerHTML = body;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
});

describe("global-error.tsx as the server-rendered document", () => {
  test("restores a saved light theme after hydrating, without a mismatch", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    loadServerHtml();
    // The server HTML says dark, and no <head> script corrected it.
    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
    const onRecoverableError = vi.fn();

    await act(async () => {
      root = hydrateRoot(document, element, { onRecoverableError });
    });

    await waitFor(() =>
      expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe(
        "light",
      ),
    );
    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  test("stays dark with nothing saved", async () => {
    loadServerHtml();

    await act(async () => {
      root = hydrateRoot(document, element);
    });

    expect(document.documentElement.getAttribute(THEME_ATTRIBUTE)).toBe("dark");
  });
});

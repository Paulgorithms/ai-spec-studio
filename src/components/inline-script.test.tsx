import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { InlineScript } from "@/components/inline-script";

describe("InlineScript", () => {
  test("renders a runnable script on the server", () => {
    // Simulate the server, where window doesn't exist.
    vi.stubGlobal("window", undefined);
    try {
      const html = renderToString(<InlineScript html="var ran = true" />);
      expect(html).toBe(
        '<script type="text/javascript">var ran = true</script>',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("renders an inert text/plain script on the client, so it never runs twice", () => {
    const { container } = render(<InlineScript html="var ran = true" />);

    const script = container.querySelector("script");
    expect(script?.getAttribute("type")).toBe("text/plain");
    expect(script?.textContent).toBe("var ran = true");
  });
});

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Field, Input } from "@/components/input";

describe("Field", () => {
  test("labels the input", () => {
    render(<Field label="Workspace name" name="workspace" />);

    const input = screen.getByRole("textbox", { name: "Workspace name" });
    expect(input.getAttribute("name")).toBe("workspace");
  });

  test("links the help text as the input's description", () => {
    render(
      <Field label="Workspace name" description="Shown in the sidebar." />,
    );

    expect(
      screen.getByRole("textbox", {
        name: "Workspace name",
        description: "Shown in the sidebar.",
      }),
    ).toBeTruthy();
  });

  test("is valid and has no description by default", () => {
    render(<Field label="Workspace name" />);

    const input = screen.getByRole("textbox", { name: "Workspace name" });
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.hasAttribute("aria-describedby")).toBe(false);
  });

  test("marks the input invalid and links the error message", () => {
    render(
      <Field
        label="Workspace name"
        description="Shown in the sidebar."
        error="Enter a workspace name."
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Workspace name",
      description: "Shown in the sidebar. Enter a workspace name.",
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Enter a workspace name.").className).toContain(
      "text-danger",
    );
  });

  test("gives each field on a page its own ids", () => {
    render(
      <>
        <Field label="First" description="First help" error="First error" />
        <Field label="Second" description="Second help" error="Second error" />
      </>,
    );

    const first = screen.getByRole("textbox", {
      name: "First",
      description: "First help First error",
    });
    const second = screen.getByRole("textbox", {
      name: "Second",
      description: "Second help Second error",
    });
    expect(first.id).not.toBe(second.id);
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("renders on the server with matching ids", () => {
    const html = renderToString(
      <Field label="Workspace name" error="Enter a workspace name." />,
    );
    const container = document.createElement("div");
    container.innerHTML = html;

    const input = container.querySelector("input");
    const label = container.querySelector("label");
    expect(input?.id).toBeTruthy();
    expect(label?.getAttribute("for")).toBe(input?.id);
    expect(input?.getAttribute("aria-describedby")).toBe(`${input?.id}-error`);
  });

  test("uses an id passed in", () => {
    render(
      <Field id="workspace-name" label="Workspace name" description="Help" />,
    );

    const input = screen.getByRole("textbox", { name: "Workspace name" });
    expect(input.id).toBe("workspace-name");
    expect(input.getAttribute("aria-describedby")).toBe(
      "workspace-name-description",
    );
  });

  test("keeps an aria-describedby passed in", () => {
    render(
      <>
        <p id="form-note">Applies to everyone.</p>
        <Field
          label="Workspace name"
          aria-describedby="form-note"
          description="Shown in the sidebar."
        />
      </>,
    );

    expect(
      screen.getByRole("textbox", {
        name: "Workspace name",
        description: "Applies to everyone. Shown in the sidebar.",
      }),
    ).toBeTruthy();
  });

  test("passes disabled through to the input", () => {
    render(<Field label="Workspace name" disabled defaultValue="Acme" />);

    const input = screen.getByRole("textbox", { name: "Workspace name" });
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(input.className).toContain("disabled:opacity-50");
  });
});

describe("Input", () => {
  test("uses the input border token and a visible focus outline", () => {
    render(<Input aria-label="Search" />);

    const { classList } = screen.getByRole("textbox", { name: "Search" });
    expect(classList.contains("border-border-input")).toBe(true);
    expect(classList.contains("focus-visible:outline-2")).toBe(true);
    expect(classList.contains("focus-visible:outline-ring")).toBe(true);
    expect(classList.contains("aria-[invalid=true]:border-danger")).toBe(true);
  });
});

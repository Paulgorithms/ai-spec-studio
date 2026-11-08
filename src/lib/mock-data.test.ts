import { describe, expect, test } from "vitest";
import { getProjects, getSpecifications } from "@/lib/mock-data";
import { SPEC_STATUSES } from "@/lib/spec-status";

const projects = getProjects();
const specifications = getSpecifications();

describe("sample data", () => {
  test("has stable, unique project ids", () => {
    const ids = projects.map((project) => project.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("has unique specification ids in the SPEC-000 format", () => {
    const ids = specifications.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^SPEC-\d{3}$/);
  });

  test("links every specification to an existing project", () => {
    const projectIds = new Set(projects.map((project) => project.id));
    for (const spec of specifications) {
      expect(projectIds.has(spec.projectId), spec.id).toBe(true);
    }
  });

  test("gives every project at least one specification", () => {
    for (const project of projects) {
      expect(
        specifications.some((spec) => spec.projectId === project.id),
        project.id,
      ).toBe(true);
    }
  });

  test("uses only the known specification statuses", () => {
    for (const spec of specifications) {
      expect(SPEC_STATUSES).toContain(spec.status);
    }
  });

  test("uses fixed, valid UTC dates", () => {
    for (const spec of specifications) {
      expect(spec.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(Number.isNaN(Date.parse(spec.updatedAt))).toBe(false);
    }
    // No two specifications share a timestamp, so "most recent" is unambiguous.
    const dates = specifications.map((spec) => spec.updatedAt);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test("returns the same records on every call", () => {
    expect(getProjects()).toBe(projects);
    expect(getSpecifications()).toBe(specifications);
  });

  test("has the expected size", () => {
    expect(projects).toHaveLength(3);
    expect(specifications).toHaveLength(12);
  });

  test("has non-empty names, titles, and descriptions", () => {
    for (const project of projects) {
      expect(project.name.trim()).not.toBe("");
      expect(project.description.trim()).not.toBe("");
    }
    for (const spec of specifications) {
      expect(spec.title.trim()).not.toBe("");
      expect(spec.summary.trim()).not.toBe("");
    }
  });
});

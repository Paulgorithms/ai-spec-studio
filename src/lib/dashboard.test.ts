import { describe, expect, test } from "vitest";
import {
  countByStatus,
  describeStatusCounts,
  getDashboardStats,
  getProjectSummaries,
  getSpecificationsWithProject,
} from "@/lib/dashboard";
import {
  getProjects,
  getSpecifications,
  type Project,
  type Specification,
} from "@/lib/mock-data";

const projects = getProjects();
const specifications = getSpecifications();

function spec(
  id: string,
  projectId: string,
  updatedAt: string,
  status: Specification["status"] = "draft",
): Specification {
  return { id, title: id, summary: "", projectId, status, updatedAt };
}

const alpha: Project = { id: "alpha", name: "Alpha", description: "" };
const beta: Project = { id: "beta", name: "Beta", description: "" };
const empty: Project = { id: "empty", name: "Empty", description: "" };

describe("getDashboardStats", () => {
  test("summarizes the sample data", () => {
    expect(getDashboardStats(projects, specifications)).toEqual({
      projects: 3,
      specifications: 12,
      statusCounts: { draft: 2, "in-review": 4, approved: 6 },
    });
  });

  test("returns zeros for no data", () => {
    expect(getDashboardStats([], [])).toEqual({
      projects: 0,
      specifications: 0,
      statusCounts: { draft: 0, "in-review": 0, approved: 0 },
    });
  });
});

describe("countByStatus and describeStatusCounts", () => {
  test("counts each status and describes the non-zero ones", () => {
    const counts = countByStatus([
      spec("A", "alpha", "2026-01-01T00:00:00Z", "approved"),
      spec("B", "alpha", "2026-01-02T00:00:00Z", "approved"),
      spec("C", "alpha", "2026-01-03T00:00:00Z", "in-review"),
    ]);

    expect(counts).toEqual({ draft: 0, "in-review": 1, approved: 2 });
    expect(describeStatusCounts(counts)).toBe("1 in review, 2 approved");
  });

  test("describes no specifications as an empty string", () => {
    expect(describeStatusCounts(countByStatus([]))).toBe("");
  });
});

describe("getSpecificationsWithProject", () => {
  test("adds project names and sorts newest first", () => {
    const result = getSpecificationsWithProject(
      [alpha, beta],
      [
        spec("SPEC-1", "alpha", "2026-01-01T00:00:00Z"),
        spec("SPEC-2", "beta", "2026-03-01T00:00:00Z"),
        spec("SPEC-3", "alpha", "2026-02-01T00:00:00Z"),
      ],
    );

    expect(result.map((s) => [s.id, s.projectName])).toEqual([
      ["SPEC-2", "Beta"],
      ["SPEC-3", "Alpha"],
      ["SPEC-1", "Alpha"],
    ]);
  });

  test("applies the limit after sorting", () => {
    const result = getSpecificationsWithProject(projects, specifications, 5);

    expect(result.map((s) => s.id)).toEqual([
      "SPEC-012",
      "SPEC-004",
      "SPEC-008",
      "SPEC-010",
      "SPEC-003",
    ]);
  });

  test("breaks timestamp ties by id, whatever the input order", () => {
    const same = "2026-01-01T00:00:00Z";
    const forward = getSpecificationsWithProject(
      [alpha],
      [spec("SPEC-1", "alpha", same), spec("SPEC-2", "alpha", same)],
    );
    const backward = getSpecificationsWithProject(
      [alpha],
      [spec("SPEC-2", "alpha", same), spec("SPEC-1", "alpha", same)],
    );

    expect(forward.map((s) => s.id)).toEqual(["SPEC-1", "SPEC-2"]);
    expect(backward.map((s) => s.id)).toEqual(["SPEC-1", "SPEC-2"]);
  });

  test("leaves out specifications whose project is missing", () => {
    const result = getSpecificationsWithProject(
      [alpha],
      [
        spec("SPEC-1", "alpha", "2026-01-01T00:00:00Z"),
        spec("SPEC-2", "gone", "2026-01-02T00:00:00Z"),
      ],
    );

    expect(result.map((s) => s.id)).toEqual(["SPEC-1"]);
  });

  test("doesn't change the input", () => {
    const input = [
      spec("SPEC-1", "alpha", "2026-01-01T00:00:00Z"),
      spec("SPEC-2", "alpha", "2026-02-01T00:00:00Z"),
    ];
    getSpecificationsWithProject([alpha], input);

    expect(input.map((s) => s.id)).toEqual(["SPEC-1", "SPEC-2"]);
  });
});

describe("getProjectSummaries", () => {
  test("summarizes each sample project, most recently updated first", () => {
    const result = getProjectSummaries(projects, specifications);

    expect(
      result.map((p) => [p.id, p.specificationCount, p.lastUpdatedAt]),
    ).toEqual([
      ["developer-platform", 4, "2026-11-06T10:05:00Z"],
      ["billing-service", 4, "2026-11-05T11:15:00Z"],
      ["mobile-onboarding", 4, "2026-11-04T08:50:00Z"],
    ]);
    expect(result[1].statusCounts).toEqual({
      draft: 1,
      "in-review": 1,
      approved: 2,
    });
  });

  test("puts projects without specifications last", () => {
    const result = getProjectSummaries(
      [empty, alpha, beta],
      [
        spec("SPEC-1", "alpha", "2026-01-01T00:00:00Z"),
        spec("SPEC-2", "beta", "2026-02-01T00:00:00Z"),
      ],
    );

    expect(result.map((p) => p.id)).toEqual(["beta", "alpha", "empty"]);
    expect(result[2]).toMatchObject({
      specificationCount: 0,
      lastUpdatedAt: null,
    });
  });

  test("applies the limit", () => {
    expect(getProjectSummaries(projects, specifications, 2)).toHaveLength(2);
  });

  test("counts across projects add up to the total", () => {
    const total = getProjectSummaries(projects, specifications).reduce(
      (sum, p) => sum + p.specificationCount,
      0,
    );
    expect(total).toBe(specifications.length);
  });
});

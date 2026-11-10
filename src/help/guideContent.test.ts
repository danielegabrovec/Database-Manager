import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  guideSteps,
  queryRecipes,
  tutorialSchema,
  TUTORIAL_SEED,
} from "./guideContent";

describe("offline operational guide", () => {
  it("executes every SQL summary example against the documented SQLite fixture", () => {
    for (const recipe of queryRecipes("sqlite")) {
      const database = new DatabaseSync(":memory:");
      database.exec(
        "PRAGMA foreign_keys=ON;" + tutorialSchema("sqlite") + TUTORIAL_SEED,
      );
      expect(() => database.exec(recipe.sql), recipe.title).not.toThrow();
      database.close();
    }
  });
  it("includes separate prerequisites, creation, existing DB, graphical edits, code and backup steps for each engine", () => {
    for (const engine of [
      "sqlite",
      "postgresql",
      "mysql",
      "mariadb",
      "mongodb",
    ] as const) {
      expect(guideSteps(engine)).toHaveLength(10);
      expect(
        guideSteps(engine).every((step) => step.explanation.length > 50),
      ).toBe(true);
      expect(queryRecipes(engine).length).toBeGreaterThanOrEqual(9);
      if (engine === "mongodb")
        for (const recipe of queryRecipes(engine))
          expect(() => JSON.parse(recipe.sql)).not.toThrow();
    }
  });
});

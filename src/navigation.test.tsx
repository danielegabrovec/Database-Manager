import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceNavigation } from "./components/WorkspaceNavigation";
import {
  NAV_FLAT,
  NAV_GROUPS,
  NAV_STANDALONE,
  navigationGroupFor,
  nextExpandedGroup,
} from "./navigation";
import type { WorkspaceView } from "./navigation";

describe("navigazione del workspace", () => {
  it("mantiene ogni area precedente e aggiunge PowerShell senza duplicare destinazioni", () => {
    const ids = NAV_FLAT.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([
      "builder",
      "codegen",
      "data",
      "designer",
      "editor",
      "environments",
      "files",
      "laboratory",
      "library",
      "powershell",
      "schema",
      "settings",
      "transfer",
    ]);
    const reachable = [
      ...NAV_STANDALONE,
      ...NAV_GROUPS.flatMap((group) => group.items),
    ].map((item) => item.id);
    expect(new Set(reachable).size).toBe(reachable.length);
    expect(reachable.sort()).toEqual(
      ids.filter((id) => id !== "settings").sort(),
    );
  });

  it("riunisce i due cataloghi con i nomi richiesti, separandoli dagli strumenti", () => {
    expect(NAV_GROUPS.map((group) => group.label)).toEqual([
      "Database",
      "Catalogo",
      "Strumenti",
    ]);
    expect(
      NAV_GROUPS.find((group) => group.id === "catalog")?.items.map(
        ({ id, label }) => ({ id, label }),
      ),
    ).toEqual([
      { id: "powershell", label: "Catalogo PowerShell" },
      { id: "library", label: "Catalogo Query" },
    ]);
    expect(NAV_STANDALONE.map((item) => item.id)).toEqual([
      "files",
      "editor",
      "laboratory",
    ]);
  });

  it("passa fra gruppi senza accumulare sezioni aperte e permette di richiuderle", () => {
    let expanded = nextExpandedGroup("database", {
      type: "toggle",
      group: "catalog",
    });
    expect(expanded).toBe("catalog");
    expanded = nextExpandedGroup(expanded, {
      type: "toggle",
      group: "catalog",
    });
    expect(expanded).toBeNull();
    expect(
      nextExpandedGroup(expanded, { type: "toggle", group: "tools" }),
    ).toBe("tools");
  });

  it("apre il gruppo della vista raggiunta anche da fuori menu, conservando il gruppo nelle aree autonome", () => {
    expect(
      nextExpandedGroup("catalog", { type: "navigate", view: "schema" }),
    ).toBe("database");
    expect(
      nextExpandedGroup("database", { type: "navigate", view: "powershell" }),
    ).toBe("catalog");
    expect(
      nextExpandedGroup(null, { type: "navigate", view: "transfer" }),
    ).toBe("tools");
    expect(
      nextExpandedGroup("catalog", { type: "navigate", view: "editor" }),
    ).toBe("catalog");
    expect(navigationGroupFor("settings")).toBeNull();
  });

  it.each<WorkspaceView>(["data", "library", "powershell", "codegen"])(
    "rende accessibile il gruppo di %s con un solo indicatore di pagina attiva",
    (view) => {
      const markup = renderToStaticMarkup(
        <WorkspaceNavigation view={view} onNavigate={() => {}} />,
      );
      const headings =
        markup.match(/<button[^>]+aria-expanded="(?:true|false)"[^>]*>/g) ?? [];
      expect(headings).toHaveLength(3);
      expect(
        headings.filter((heading) => heading.includes('aria-expanded="true"')),
      ).toHaveLength(1);
      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      const expanded = headings.find((heading) =>
        heading.includes('aria-expanded="true"'),
      )!;
      const controls = expanded.match(/aria-controls="([^"]+)"/)?.[1];
      expect(controls).toBeTruthy();
      expect(markup).toContain(
        `id="${controls}" class="workspace-nav-children" role="group"`,
      );
    },
  );

  it.each<WorkspaceView>(["files", "editor"])(
    "parte con tutti i gruppi chiusi da %s e apre Catalogo al primo clic",
    (view) => {
      const markup = renderToStaticMarkup(
        <WorkspaceNavigation view={view} onNavigate={() => {}} />,
      );
      expect(markup).toContain('data-group="catalog"');
      expect(markup).not.toContain('aria-expanded="true"');
      expect(markup.match(/aria-expanded="false"/g)).toHaveLength(3);
      expect(
        markup.match(/class="workspace-nav-children" hidden=""/g),
      ).toHaveLength(3);
      expect(
        nextExpandedGroup(navigationGroupFor(view), {
          type: "toggle",
          group: "catalog",
        }),
      ).toBe("catalog");
      expect(markup).toContain("Catalogo PowerShell");
      expect(markup).toContain("Catalogo Query");
      expect(markup).not.toContain('role="menu"');
    },
  );
});

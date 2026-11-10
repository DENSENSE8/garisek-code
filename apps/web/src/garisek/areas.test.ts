import { describe, expect, it } from "vite-plus/test";

import { garisekAreaForPath, railSelectionFor } from "./areas";

describe("garisekAreaForPath", () => {
  it("gives a Garisek-OS path to the area that owns it, and no area for the rest", () => {
    expect(garisekAreaForPath("/finance")?.id).toBe("money");
    expect(garisekAreaForPath("/finance/transactions?range=30d")?.id).toBe("money");
    expect(garisekAreaForPath("/self-improvement#logs")?.id).toBe("health");
    expect(garisekAreaForPath("/execute")?.id).toBe("today");
    expect(garisekAreaForPath("/daily?list=inbox")?.id).toBe("reminders");
    expect(garisekAreaForPath("/hub")?.id).toBe("desk");
    expect(garisekAreaForPath("/financeish")).toBeNull();
    expect(garisekAreaForPath("/signin?next=%2Ffinance")).toBeNull();
    expect(garisekAreaForPath("/")).toBeNull();
  });
});

describe("railSelectionFor", () => {
  it("selects from the T3 location", () => {
    expect(railSelectionFor("/garisek/money")).toMatchObject({
      kind: "garisek",
      area: { id: "money" },
    });
    expect(railSelectionFor("/garisek/unknown")).toMatchObject({
      kind: "garisek",
      area: { id: "desk" },
    });
    expect(railSelectionFor("/settings/garisek")).toEqual({ kind: "settings" });
    expect(railSelectionFor("/settingsx")).toEqual({ kind: "code" });
    expect(railSelectionFor("/")).toEqual({ kind: "code" });
  });
});

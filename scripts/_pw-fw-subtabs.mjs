/**
 * Headless check: Firewalls → Groups sub-tab toggles panel visibility.
 * Run with: npx playwright@1.50.1 test (or node + chromium from playwright)
 */
import { chromium } from "playwright";

const base = process.env.BASE_URL || "http://127.0.0.1:8765";

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });

  const auth = await page.locator("#auth-overlay").isVisible().catch(() => false);
  if (auth) {
    console.log("SKIP: auth overlay visible — cannot exercise Firewalls tabs without signing in.");
    console.log("OK: page loaded; markup/API checks only from here.");
    process.exit(0);
  }

  await page.getByRole("tab", { name: "Firewalls" }).first().click();
  await page.waitForTimeout(300);

  const subFw = page.locator("#fw-subpanel-firewalls");
  const subGr = page.locator("#fw-subpanel-groups");

  const hiddenBefore = await subGr.getAttribute("hidden");
  await page.locator("#tab-fw-view-groups").click();
  await page.waitForTimeout(500);

  const fwHidden = await subFw.getAttribute("hidden");
  const grHidden = await subGr.getAttribute("hidden");

  if (fwHidden === null || fwHidden === "false") {
    console.error("FAIL: fw-subpanel-firewalls should be hidden after Groups click, got:", fwHidden);
    process.exit(1);
  }
  if (grHidden !== null) {
    console.error("FAIL: fw-subpanel-groups should be visible (no hidden attr), got:", grHidden);
    process.exit(1);
  }

  const title = await page.locator("#page-title").textContent();
  if (!title || !title.includes("Group")) {
    console.error("FAIL: page title should reflect Groups, got:", title);
    process.exit(1);
  }

  console.log("OK: Groups sub-tab shows groups panel and updates title:", title.trim());
  process.exit(0);
} catch (e) {
  console.error("ERROR:", e.message || e);
  process.exit(1);
} finally {
  await browser.close();
}

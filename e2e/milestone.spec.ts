import { expect, test } from "@playwright/test";

test("a client can request, preview, approve, and publish a headline change", async ({ page }) => {
  const headline = `Cedar ${Date.now()}`;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill("client@northwind.test");
  await page.getByLabel("Password").fill("Harbor-Client-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "What should change?" })).toBeVisible();
  await expect(page.locator("details.mobile-history")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel("What should change?").fill(`Change the headline to ${headline}`);
  await page.getByRole("button", { name: "Send request" }).click();
  const previewLink = page.getByRole("link", { name: "Open preview" });
  await expect(previewLink).toBeVisible();
  const href = await previewLink.getAttribute("href");
  expect(href).toContain("/api/previews/");
  const preview = await page.context().newPage();
  await preview.goto(href!);
  await expect(preview.getByRole("heading", { name: headline })).toBeVisible();
  await preview.close();

  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "published" })).toBeVisible();
});

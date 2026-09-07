export async function captureMobileDashboardScreenshot(page, testInfo, screenshotPath) {
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
  } catch (error) {
    console.warn(`Unable to capture mobile dashboard screenshot: ${error.message}`);
    return;
  }
  await testInfo.attach("mobile-dashboard-screenshot", {
    path: screenshotPath,
    contentType: "image/png",
  });
}

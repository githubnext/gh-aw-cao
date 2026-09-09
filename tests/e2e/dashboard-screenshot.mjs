export async function captureMobileDashboardScreenshot(
  page,
  testInfo,
  screenshotPath,
) {
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`Unable to capture mobile dashboard screenshot: ${reason}`)
    return
  }
  await testInfo.attach('mobile-dashboard-screenshot', {
    path: screenshotPath,
    contentType: 'image/png',
  })
}

export const siteName = "Rend";
export const siteOrigin = "https://rend.so";
export const siteTitle = "Rend, video infrastructure built for speed";
export const siteDescription =
  "Rend is the video platform for developers. One API call to upload, one URL that plays instantly anywhere in the world. Open source, on hardware we own.";
export const siteLocale = "en_US";
export const themeColor = "#fcfbf8";
export const backgroundColor = "#fcfbf8";
export const brandColor = "#161513";
export const ogImageSize = { width: 1200, height: 630 };

export function absoluteSiteUrl(path = "/") {
  return new URL(path, siteOrigin).toString();
}

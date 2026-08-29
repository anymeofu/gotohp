// Endpoint URLs, signatures, package names, and service strings, copied
// verbatim from backend/googleauth.go and backend/api.go.

// --- googleauth.go (Option 1: embedded-setup exchange) ---
export const EMBEDDED_SETUP_AUTH_ENDPOINT = "https://android.clients.google.com/auth";
export const GOOGLE_AUTH_EMAIL_HINT = "oauth-token@example.com";
export const GOOGLE_PLAY_SERVICES_SIG = "38918a453d07199354f8b19af05ec6562ced5788";
export const GOOGLE_PHOTOS_PACKAGE = "com.google.android.apps.photos";
export const GOOGLE_PHOTOS_SIG = "24bb24c05e47e0aefa68a58a766179d9b613a600";
export const GOOGLE_PHOTOS_SERVICE =
  "oauth2:openid https://www.googleapis.com/auth/mobileapps.native https://www.googleapis.com/auth/photos.native";

// --- api.go (Api client) ---
export const ANDROID_AUTH_ENDPOINT = "https://android.googleapis.com/auth";
export const UPLOAD_INTERACTIVE_ENDPOINT =
  "https://photos.googleapis.com/data/upload/uploadmedia/interactive";
export const HASH_CHECK_ENDPOINT =
  "https://photosdata-pa.googleapis.com/6439526531001121323/5084965799730810217";
export const PHOTOS_CREATE_MEDIA_ITEMS_ENDPOINT =
  "https://photosdata-pa.googleapis.com/6439526531001121323/16538846908252377752";
export const CREATE_ALBUM_ENDPOINT =
  "https://photosdata-pa.googleapis.com/6439526531001121323/8386163679468898444";
export const ADD_MEDIA_TO_ALBUM_ENDPOINT =
  "https://photosdata-pa.googleapis.com/6439526531001121323/484917746253879292";

// Fixed device profile used to build the Api's User-Agent and CommitUpload/
// CreateAlbum/AddMediaToAlbum device_info messages. Matches newAPIFromCredential.
export const DEFAULT_ANDROID_API_VERSION = 28;
export const DEFAULT_MODEL = "Pixel XL";
export const DEFAULT_MAKE = "Google";
export const DEFAULT_CLIENT_VERSION_CODE = 49029607;
// Saver mode swaps the device model (backend/api.go CommitUpload).
export const SAVER_MODEL = "Pixel 2";
// UseQuota mode swaps the device model (backend/api.go CommitUpload).
export const USE_QUOTA_MODEL = "Pixel 8";

// Fixed extra headers sent on CommitUpload/CreateAlbum/AddMediaToAlbum requests.
export const GOOG_EXT_173412678_BIN = "CgcIAhClARgC";
export const GOOG_EXT_174067345_BIN = "CgIIAg==";

// album.go batching constants.
export const ALBUM_BATCH_SIZE = 500;
export const ALBUM_LIMIT = 20000;
export const ALBUM_KEY_PREFIX = "AF1Qip";

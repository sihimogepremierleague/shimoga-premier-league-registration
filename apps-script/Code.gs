/**
 * Shimoga Premier League - Google Form bridge
 *
 * Website -> Apps Script -> Google Form
 *
 * 1. Create your Google Form with these question titles:
 *    Name
 *    Age
 *    Date of Birth
 *    Category
 *    Mobile Number
 *    Comments
 *    Display Photo   (Short answer - stores a Google Drive link)
 *    Document        (Short answer - stores a Google Drive link)
 *
 *    Apps Script cannot submit files into Google Form "File upload"
 *    questions, so uploads are saved to a private Drive folder and the
 *    file links are written into these two questions instead.
 *
 * 2. Replace GOOGLE_FORM_ID below.
 *    Use the EDIT id from https://docs.google.com/forms/d/<EDIT_ID>/edit
 *    (not the public /forms/d/e/1FAIpQLS.../viewform id).
 * 3. Deploy as a Web app:
 *    Execute as: Me
 *    Who has access: Anyone
 * 4. Copy the Web app URL into index.html.
 *
 * The website posts a JSON string with Content-Type text/plain so the browser
 * treats it as a CORS simple request. Apps Script web apps cannot answer
 * preflight OPTIONS requests and cannot set custom response headers, so this
 * is the only way to call them from a browser on another origin.
 *
 * The script submits into the Google Form itself, so the normal
 * Google Form response destination (including Google Sheets) continues
 * to work.
 */

const GOOGLE_FORM_ID = "1Or1-sY_4m10QPwC5O5XQKNxPBEoo98YF1ncsbHixeRk";

// Bump this when you edit the script, then redeploy a NEW version.
// Opening the /exec URL in a browser must echo the same value back.
const DEPLOY_MARKER = "2026-10-06-drive-uploads";

// Uploaded files are stored in this Drive folder, owned by the script owner
// and private by default. Set UPLOAD_FOLDER_ID to use an existing folder;
// otherwise a folder named UPLOAD_FOLDER_NAME is found or created in My Drive.
const UPLOAD_FOLDER_ID = "";
const UPLOAD_FOLDER_NAME = "SPL Registration Uploads";

const FILE_LINK_TITLES = ["Display Photo", "Document"];

const EXPECTED_TITLES = [
  "Name",
  "Age",
  "Date of Birth",
  "Category",
  "Mobile Number",
  "Comments",
  "Display Photo",
  "Document"
];

/**
 * Health check. Open the /exec URL directly in a browser after deploying.
 * Reports the deployed code version, whether GOOGLE_FORM_ID can be opened,
 * and which expected question titles are present or missing.
 */
function doGet() {
  const diagnostics = { status: "ok", deployedVersion: DEPLOY_MARKER };

  try {
    const form = FormApp.openById(GOOGLE_FORM_ID);
    const items = form.getItems().map(function (item) {
      return { title: item.getTitle(), type: String(item.getType()) };
    });
    const titles = items.map(function (item) {
      return item.title.trim().toLowerCase();
    });

    diagnostics.formTitle = form.getTitle();
    diagnostics.items = items;
    diagnostics.missingTitles = EXPECTED_TITLES.filter(function (title) {
      return titles.indexOf(title.toLowerCase()) === -1;
    });
    diagnostics.wrongTypeTitles = findWrongTypeFileLinkTitles(form);
    diagnostics.acceptsResponses = form.isAcceptingResponses();
    if (diagnostics.missingTitles.length || diagnostics.wrongTypeTitles.length) {
      diagnostics.status = "error";
    }
  } catch (err) {
    diagnostics.status = "error";
    diagnostics.message = err && err.message ? err.message : String(err);
    diagnostics.hint =
      "GOOGLE_FORM_ID must be the edit id from /forms/d/<EDIT_ID>/edit, " +
      "not the published /forms/d/e/1FAIpQLS.../viewform id.";
  }

  return jsonResponse(diagnostics);
}

function doPost(e) {
  const savedFiles = [];

  try {
    const data = parseRequestPayload(e);
    const form = FormApp.openById(GOOGLE_FORM_ID);
    const missing = findMissingTitles(form);
    if (missing.length) {
      throw new Error(
        "Google Form is missing these question titles: " + missing.join(", ")
      );
    }

    // Fail before writing anything to Drive if the form is misconfigured.
    const wrongType = findWrongTypeFileLinkTitles(form);
    if (wrongType.length) {
      throw new Error(
        "Change these Google Form questions to Short answer so file links can be stored: " +
        wrongType.join(", ")
      );
    }

    const response = form.createResponse();
    const skipped = [];
    const filePrefix = buildFilePrefix(data);

    addText(response, form, "Name", data.name, skipped);
    addText(response, form, "Age", data.age, skipped);
    addDate(response, form, "Date of Birth", data.dob, skipped);
    addChoice(response, form, "Category", data.category, skipped);
    addText(response, form, "Mobile Number", data.mobile, skipped);
    addText(response, form, "Comments", data.comment, skipped);
    addFileLink(response, form, "Display Photo", data.photo, filePrefix, savedFiles, skipped);
    addFileLink(response, form, "Document", data.document, filePrefix, savedFiles, skipped);

    response.submit();

    if (skipped.length) {
      console.warn("Submitted, but these values had no matching form item: " + skipped.join(", "));
    }

    return jsonResponse({ status: "success", skippedFields: skipped });
  } catch (err) {
    console.error(err);
    trashFiles(savedFiles);
    return jsonResponse({
      status: "error",
      message: err && err.message ? err.message : String(err)
    });
  }
}

/**
 * Run this once from the Apps Script editor after pasting the code.
 * It triggers the Google Drive authorization prompt and creates the upload
 * folder. The web app cannot save uploads until this has been authorized.
 */
function setupUploadFolder() {
  const folder = getUploadFolder();
  console.log("Upload folder ready: " + folder.getName() + " -> " + folder.getUrl());
  return folder.getUrl();
}

function findWrongTypeFileLinkTitles(form) {
  return FILE_LINK_TITLES.filter(function (title) {
    return !findItem(form, title, FormApp.ItemType.TEXT) &&
           !findItem(form, title, FormApp.ItemType.PARAGRAPH_TEXT);
  });
}

function findMissingTitles(form) {
  const titles = form.getItems().map(function (item) {
    return item.getTitle().trim().toLowerCase();
  });
  return EXPECTED_TITLES.filter(function (title) {
    return titles.indexOf(title.toLowerCase()) === -1;
  });
}

function parseRequestPayload(e) {
  if (e && e.postData && e.postData.contents) {
    // The website posts a JSON string as text/plain to avoid a CORS preflight,
    // so parse the body regardless of the declared content type.
    try {
      return JSON.parse(e.postData.contents);
    } catch (err) {
      // fall through to form-encoded parameters
    }
  }

  return e && e.parameter ? e.parameter : {};
}

function addText(response, form, title, value, skipped) {
  if (!value) return;

  const textItem = findItem(form, title, FormApp.ItemType.TEXT);
  if (textItem) {
    response.withItemResponse(textItem.asTextItem().createResponse(String(value)));
    return;
  }

  // A "Long answer" question is PARAGRAPH_TEXT, which is a distinct item type
  // that asTextItem() cannot handle.
  const paragraphItem = findItem(form, title, FormApp.ItemType.PARAGRAPH_TEXT);
  if (paragraphItem) {
    response.withItemResponse(paragraphItem.asParagraphTextItem().createResponse(String(value)));
    return;
  }

  noteSkipped(skipped, title, "no short-answer or long-answer question with this title");
}

function addDate(response, form, title, value, skipped) {
  if (!value) return;

  const item = findItem(form, title, FormApp.ItemType.DATE);
  if (!item) {
    noteSkipped(skipped, title, "no date question with this title");
    return;
  }

  const parts = String(value).split("-");
  if (parts.length !== 3) {
    noteSkipped(skipped, title, "value is not in YYYY-MM-DD format");
    return;
  }

  const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  response.withItemResponse(item.asDateItem().createResponse(date));
}

function addChoice(response, form, title, value, skipped) {
  if (!value) return;

  const item = findItem(form, title, FormApp.ItemType.MULTIPLE_CHOICE) ||
               findItem(form, title, FormApp.ItemType.LIST);
  if (!item) {
    noteSkipped(skipped, title, "no multiple-choice or dropdown question with this title");
    return;
  }

  if (item.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
    response.withItemResponse(item.asMultipleChoiceItem().createResponse(String(value)));
  } else {
    response.withItemResponse(item.asListItem().createResponse(String(value)));
  }
}

function addFileLink(response, form, title, value, filePrefix, savedFiles, skipped) {
  if (!value) return;

  const item = findItem(form, title, FormApp.ItemType.TEXT) ||
               findItem(form, title, FormApp.ItemType.PARAGRAPH_TEXT);
  if (!item) {
    noteSkipped(skipped, title, "no short-answer question with this title");
    return;
  }

  const match = typeof value === "string" && value.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    noteSkipped(skipped, title, "value was not a base64 data URL");
    return;
  }

  const mimeType = match[1].toLowerCase();
  if (mimeType.indexOf("image/") !== 0 && mimeType !== "application/pdf") {
    throw new Error(title + " must be an image or PDF file (received " + mimeType + ").");
  }

  const fileName = filePrefix + "_" + slugify(title) + getFileExtensionFromMime(mimeType);
  const blob = Utilities.newBlob(Utilities.base64Decode(match[2]), mimeType, fileName);
  const file = getUploadFolder().createFile(blob);
  savedFiles.push(file);

  const url = file.getUrl();
  if (item.getType() === FormApp.ItemType.PARAGRAPH_TEXT) {
    response.withItemResponse(item.asParagraphTextItem().createResponse(url));
  } else {
    response.withItemResponse(item.asTextItem().createResponse(url));
  }
}

function getUploadFolder() {
  if (UPLOAD_FOLDER_ID) {
    return DriveApp.getFolderById(UPLOAD_FOLDER_ID);
  }

  const folders = DriveApp.getRootFolder().getFoldersByName(UPLOAD_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(UPLOAD_FOLDER_NAME);
}

function trashFiles(files) {
  files.forEach(function (file) {
    try {
      file.setTrashed(true);
    } catch (err) {
      console.error("Could not trash orphaned upload " + file.getName() + ": " + err);
    }
  });
}

function buildFilePrefix(data) {
  const stamp = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyyMMdd-HHmmss");
  const parts = [stamp, slugify(data.mobile), slugify(data.name)].filter(Boolean);
  return parts.join("_");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function noteSkipped(skipped, title, reason) {
  if (skipped) skipped.push(title + " (" + reason + ")");
}

function getFileExtensionFromMime(mimeType) {
  const extensions = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "application/pdf": ".pdf"
  };
  return extensions[mimeType] || "";
}

function findItem(form, title, type) {
  const items = form.getItems(type);
  for (let i = 0; i < items.length; i++) {
    if (items[i].getTitle().trim().toLowerCase() === title.trim().toLowerCase()) {
      return items[i];
    }
  }
  return null;
}

function jsonResponse(payload) {
  // Apps Script web apps cannot set custom response headers; ContentService
  // output already carries Access-Control-Allow-Origin: * for simple requests.
  const output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

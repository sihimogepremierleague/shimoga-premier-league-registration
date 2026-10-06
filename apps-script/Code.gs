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
const DEPLOY_MARKER = "2026-10-06-echo-retry-safe";

// Uploaded files are stored in this Drive folder, owned by the script owner
// and private by default. Set UPLOAD_FOLDER_ID to use an existing folder;
// otherwise a folder named UPLOAD_FOLDER_NAME is found or created in My Drive.
const UPLOAD_FOLDER_ID = "";
const UPLOAD_FOLDER_NAME = "SPL Registration Uploads";

const FILE_LINK_TITLES = ["Display Photo", "Document"];

// Matches the 3 MB limit enforced by the website.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

// Match the maxlength limits on the website.
const MAX_NAME_LENGTH = 50;
const MAX_COMMENT_LENGTH = 250;

// Script property prefix for submission ids that were saved, so a browser
// retry after a lost response cannot register the same player twice.
const SUBMISSION_KEY_PREFIX = "submission:";

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
 * GET handler.
 *   /exec                      -> fast liveness check (no Form/Drive access)
 *   /exec?diagnostics=1        -> full configuration check with timings
 *   /exec?submissionId=<id>    -> whether that submission was recorded
 *
 * The plain /exec check is kept cheap because Apps Script sometimes redirects
 * a POST's output URL back to /exec as a GET; a slow doGet makes that worse.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.submissionId) {
    const id = String(params.submissionId);
    if (!isValidSubmissionId(id)) {
      return jsonResponse({ status: "error", message: "Invalid submission id." });
    }
    return jsonResponse({
      status: isSubmissionRecorded(id) ? "success" : "not_found",
      submissionId: id
    });
  }

  if (!params.diagnostics) {
    return jsonResponse({ status: "ok", deployedVersion: DEPLOY_MARKER });
  }

  const started = Date.now();
  const timingsMs = {};
  const diagnostics = { status: "ok", deployedVersion: DEPLOY_MARKER, timingsMs: timingsMs };

  try {
    let t = Date.now();
    const form = FormApp.openById(GOOGLE_FORM_ID);
    timingsMs.openForm = Date.now() - t;

    t = Date.now();
    const index = getItemIndex(form);
    const items = index.all.map(function (entry) {
      return { title: entry.title, type: String(entry.type) };
    });
    timingsMs.readItems = Date.now() - t;

    diagnostics.formTitle = form.getTitle();
    diagnostics.items = items;
    diagnostics.missingTitles = findMissingTitles(form);
    diagnostics.wrongTypeTitles = findWrongTypeFileLinkTitles(form);
    diagnostics.acceptsResponses = form.isAcceptingResponses();

    t = Date.now();
    diagnostics.responseCount = form.getResponses().length;
    timingsMs.readResponses = Date.now() - t;

    if (!diagnostics.missingTitles.length) {
      t = Date.now();
      hasExistingRegistration(form, "__diagnostics__", "0000000000");
      timingsMs.duplicateScan = Date.now() - t;
    }

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

  try {
    const t = Date.now();
    diagnostics.uploadFolderExists = UPLOAD_FOLDER_ID
      ? Boolean(DriveApp.getFolderById(UPLOAD_FOLDER_ID))
      : DriveApp.getRootFolder().getFoldersByName(UPLOAD_FOLDER_NAME).hasNext();
    timingsMs.checkDrive = Date.now() - t;
    diagnostics.driveAuthorized = true;
  } catch (err) {
    diagnostics.status = "error";
    diagnostics.driveAuthorized = false;
    diagnostics.driveHint =
      "Open the Apps Script editor, select setupUploadFolder, click Run and " +
      "accept the Google Drive permission prompt as the deployment owner.";
  }

  try {
    diagnostics.recordedSubmissionIds = Object.keys(PropertiesService.getScriptProperties().getProperties())
      .filter(function (key) { return key.indexOf(SUBMISSION_KEY_PREFIX) === 0; }).length;
  } catch (err) {
    diagnostics.status = "error";
    diagnostics.propertiesError = err && err.message ? err.message : String(err);
  }

  timingsMs.total = Date.now() - started;
  return jsonResponse(diagnostics);
}

function doPost(e) {
  const savedFiles = [];
  const lock = LockService.getScriptLock();
  let locked = false;
  let submitted = false;
  const started = Date.now();

  try {
    const data = parseRequestPayload(e);
    if (!data || typeof data.name !== "string" || !data.name.trim()) {
      throw new Error("Please enter your name.");
    }
    if (typeof data.mobile !== "string" || !/^[0-9]{10}$/.test(data.mobile)) {
      throw new Error("Please enter exactly 10 digits for your mobile number.");
    }
    data.name = data.name.trim().replace(/\s+/g, " ");
    if (data.name.length > MAX_NAME_LENGTH) {
      throw new Error("Name must be " + MAX_NAME_LENGTH + " characters or fewer.");
    }
    if (data.comment != null && typeof data.comment !== "string") {
      throw new Error("Comments must be text.");
    }
    data.comment = (data.comment || "").trim();
    if (data.comment.length > MAX_COMMENT_LENGTH) {
      throw new Error("Comments must be " + MAX_COMMENT_LENGTH + " characters or fewer.");
    }
    const submissionId = data.submissionId == null ? "" : String(data.submissionId);
    if (submissionId && !isValidSubmissionId(submissionId)) {
      throw new Error("Invalid submission id.");
    }

    locked = lock.tryLock(30000);
    if (!locked) {
      return jsonResponse({
        status: "error",
        retryable: true,
        message: "The registration service is busy. Please try again shortly."
      });
    }

    // A retry of a submission that was already saved (its response was lost
    // on the way back to the browser) must not create a second registration.
    if (submissionId && isSubmissionRecorded(submissionId)) {
      return jsonResponse({ status: "success", alreadyRecorded: true });
    }

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

    if (hasExistingRegistration(form, data.name, data.mobile)) {
      throw new Error("A registration with this name and mobile number already exists. Please contact the organizers if you need to update it.");
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
    submitted = true;

    if (submissionId) {
      try {
        recordSubmission(submissionId);
      } catch (err) {
        console.error("Registration saved, but submission id was not recorded: " + err);
      }
    }

    if (skipped.length) {
      console.warn("Submitted, but these values had no matching form item: " + skipped.join(", "));
    }

    console.log("Registration saved in " + (Date.now() - started) + " ms");
    return jsonResponse({ status: "success", skippedFields: skipped });
  } catch (err) {
    console.error(err);
    if (submitted) {
      // The Form response exists and links to these files; keep them.
      return jsonResponse({ status: "success" });
    }
    trashFiles(savedFiles);
    return jsonResponse({
      status: "error",
      message: err && err.message ? err.message : String(err)
    });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function isValidSubmissionId(id) {
  return /^[A-Za-z0-9-]{8,64}$/.test(id);
}

function isSubmissionRecorded(id) {
  return PropertiesService.getScriptProperties().getProperty(SUBMISSION_KEY_PREFIX + id) !== null;
}

function recordSubmission(id) {
  PropertiesService.getScriptProperties().setProperty(SUBMISSION_KEY_PREFIX + id, new Date().toISOString());
}

function normalizeRegistrationName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function hasExistingRegistration(form, name, mobile) {
  const nameItem = findItemByTitle(form, "Name");
  const mobileItem = findItemByTitle(form, "Mobile Number");
  if (!nameItem || !mobileItem) return false;

  const normalizedName = normalizeRegistrationName(name);
  return form.getResponses().some(function (response) {
    const mobileAnswer = response.getResponseForItem(mobileItem);
    if (!mobileAnswer || String(mobileAnswer.getResponse()).trim() !== mobile) return false;
    const nameAnswer = response.getResponseForItem(nameItem);
    return Boolean(nameAnswer) && normalizeRegistrationName(nameAnswer.getResponse()) === normalizedName;
  });
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
  const index = getItemIndex(form);
  return EXPECTED_TITLES.filter(function (title) {
    return !index.byTitle[title.toLowerCase()];
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

  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(title + " must be 3 MB or smaller.");
  }

  const fileName = filePrefix + "_" + slugify(title) + getFileExtensionFromMime(mimeType);
  const blob = Utilities.newBlob(bytes, mimeType, fileName);
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

// Every Form API call is a remote round trip, so read the items once per
// request instead of calling getItems()/getTitle() for each lookup.
const itemIndexCache = new WeakMap();

function getItemIndex(form) {
  let index = itemIndexCache.get(form);
  if (index) return index;

  index = { all: [], byTitle: {} };
  form.getItems().forEach(function (item) {
    const entry = { item: item, title: item.getTitle(), type: item.getType() };
    const key = entry.title.trim().toLowerCase();
    index.all.push(entry);
    (index.byTitle[key] = index.byTitle[key] || []).push(entry);
  });
  itemIndexCache.set(form, index);
  return index;
}

function findItem(form, title, type) {
  const entries = getItemIndex(form).byTitle[title.trim().toLowerCase()] || [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === type) return entries[i].item;
  }
  return null;
}

function findItemByTitle(form, title) {
  const entries = getItemIndex(form).byTitle[title.trim().toLowerCase()];
  return entries ? entries[0].item : null;
}

function jsonResponse(payload) {
  // Apps Script web apps cannot set custom response headers; ContentService
  // output already carries Access-Control-Allow-Origin: * for simple requests.
  const output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

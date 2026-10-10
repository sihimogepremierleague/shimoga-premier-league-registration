/**
 * Shimoga Premier League - Google Form bridge
 *
 * Website -> Apps Script -> Google Form
 *
 * 1. Create your Google Form with these question titles:
 *    Name
 *    Age
 *    Date of Birth
 *    Category        (Dropdown or Multiple choice: every value in CATEGORIES)
 *    Mobile Number
 *    T-Shirt Size    (Dropdown or Multiple choice: S, M, L, XL, XXL)
 *    Comments
 *    Display Photo   (Short answer - stores a Google Drive link)
 *    Document        (Short answer - stores a Google Drive link)
 *    Created Date    (Short answer - IST submission time, e.g. 2026-10-08 21:41:38)
 *    Player Tournament Age (Short answer - age on TOURNAMENT_AGE_CUTOFF)
 *
 *    Apps Script cannot submit files into Google Form "File upload"
 *    questions, so uploads are saved to a private Drive folder and the
 *    file links are written into these two questions instead.
 *
 * 2. Replace GOOGLE_FORM_ID below.
 *    Use the EDIT id from https://docs.google.com/forms/d/<EDIT_ID>/edit
 *    (not the public /forms/d/e/1FAIpQLS.../viewform id).
 *    The form must not collect email addresses or require sign-in, so
 *    registrations can use the fast /formResponse submit (see FORM_MAP_KEY).
 * 3. Run setup() once from the editor and accept the permission prompts.
 * 4. Deploy as a Web app:
 *    Execute as: Me
 *    Who has access: Anyone
 * 5. Copy the Web app URL into index.html.
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
const DEPLOY_MARKER = "2026-10-10-jumbled-categories";

// Uploaded files are stored in this Drive folder, owned by the script owner
// and private by default. Set UPLOAD_FOLDER_ID to use an existing folder;
// otherwise a folder named UPLOAD_FOLDER_NAME is found or created in My Drive.
const UPLOAD_FOLDER_ID = "";
const UPLOAD_FOLDER_NAME = "SPL Registration Uploads";

const FILE_LINK_TITLES = ["Display Photo", "Document"];

// Matches the 5 MB limit enforced by the website.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Match the maxlength limits on the website.
const MAX_NAME_LENGTH = 50;
const MAX_COMMENT_LENGTH = 250;

// Must match the website dropdown and the Google Form "T-Shirt Size" choices.
const TSHIRT_SIZES = ["S", "M", "L", "XL", "XXL"];

// Must match the website dropdown and the Google Form "Category" choices
// (spelling, spacing and punctuation exactly).
const CATEGORIES = [
  "G/N Doubles",
  "30+ Men's Doubles",
  "40+ Men's Doubles",
  "50+ Jumbled",
  "35+ Jumbled"
];

// The league is on 6 Dec 2026. "Player Tournament Age" is the age on 5 Jun 2027,
// which gives every age category a 6-month relaxation.
// Keep in sync with TOURNAMENT_AGE_CUTOFF in index.html.
const TOURNAMENT_AGE_CUTOFF = "2027-06-05";

const CREATED_DATE_TIMEZONE = "Asia/Kolkata";
const CREATED_DATE_FORMAT = "yyyy-MM-dd HH:mm:ss";

// Script property prefix for submission ids that were saved, so a browser
// retry after a lost response cannot register the same player twice.
const SUBMISSION_KEY_PREFIX = "submission:";

// Script property index of registered players, keyed by mobile number with a
// JSON array of normalized names, so the duplicate check is a single property
// read instead of a scan of every Form response.
const REGISTRATION_KEY_PREFIX = "reg:";
const REGISTRATION_INDEX_READY_KEY = "registrationIndexReady";

// Drive folder id cached after the first lookup to avoid a Drive search on
// every registration.
const UPLOAD_FOLDER_ID_KEY = "uploadFolderId";

// Kept well below the ~30 s point where Google's echo URL starts failing.
const LOCK_WAIT_MS = 20000;

// Fast submission: a registration is posted to the Form's public /formResponse
// endpoint (one HTTP call, ~1 s) instead of ~40 FormApp calls (~4 s). The
// title -> entry id map is cached in Script Properties, refreshed in the
// background by the website's prepare request, and only used while fresh.
// The website normally posts to /formResponse itself; Apps Script uses the
// same map on its fallback path.
const FORM_MAP_KEY = "formMap";
const FORM_MAP_REFRESH_MS = 10 * 60 * 1000;
const FORM_MAP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FORM_MAP_REFRESHING_KEY = "formMapRefreshing";

// Direct uploads: the website PUTs the photo and document straight to Drive
// resumable-upload URLs created here, so Submit never waits on Apps Script.
const UPLOAD_KINDS = { photo: "Display Photo", document: "Document" };
const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,mimeType,size";
// Uploads keep this prefix until a registration links them; only pending
// uploads can be discarded.
const PENDING_UPLOAD_PREFIX = "pending_";
const MAX_SESSIONS_PER_KIND = 3;
const MAX_SESSION_REQUESTS_PER_MINUTE = 120;
const ORPHAN_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DUPLICATE_MESSAGE =
  "A registration with this name and mobile number already exists. " +
  "Please contact the organizers if you need to update it.";

const EXPECTED_TITLES = [
  "Name",
  "Age",
  "Date of Birth",
  "Category",
  "Mobile Number",
  "T-Shirt Size",
  "Comments",
  "Display Photo",
  "Document",
  "Created Date",
  "Player Tournament Age"
];

/**
 * GET handler.
 *   /exec                      -> fast liveness check (no Form/Drive access)
 *   /exec?warm=1               -> liveness check that also refreshes a stale
 *                                 Form entry map
 *   /exec?prepare=1&origin=<o> -> Form entry map + Drive upload URLs, fetched
 *                                 by the website as soon as it opens
 *   /exec?check=1&name=&mobile= -> background duplicate pre-check
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

  if (params.prepare) return handlePrepare(params);
  if (params.check) return handleCheck(params);

  if (!params.diagnostics) {
    if (params.warm) {
      try {
        refreshFormMapIfStale();
      } catch (err) {
        console.warn("Could not refresh the Form entry map: " + err);
      }
    }
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
    diagnostics.missingCategoryChoices = findMissingCategoryChoices(form);
    diagnostics.acceptsResponses = form.isAcceptingResponses();

    t = Date.now();
    diagnostics.responseCount = form.getResponses().length;
    timingsMs.readResponses = Date.now() - t;

    if (!diagnostics.missingTitles.length) {
      t = Date.now();
      hasExistingRegistration(form, "__diagnostics__", "0000000000");
      timingsMs.duplicateScan = Date.now() - t;
    }

    if (diagnostics.missingTitles.length || diagnostics.wrongTypeTitles.length ||
        diagnostics.missingCategoryChoices.length) {
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
    const properties = PropertiesService.getScriptProperties();
    const keys = Object.keys(properties.getProperties());
    diagnostics.recordedSubmissionIds = keys
      .filter(function (key) { return key.indexOf(SUBMISSION_KEY_PREFIX) === 0; }).length;
    diagnostics.registrationIndexReady = keys.indexOf(REGISTRATION_INDEX_READY_KEY) !== -1;
    diagnostics.indexedMobileNumbers = keys
      .filter(function (key) { return key.indexOf(REGISTRATION_KEY_PREFIX) === 0; }).length;
    const handlers = ScriptApp.getProjectTriggers().map(function (trigger) {
      return trigger.getHandlerFunction();
    });
    diagnostics.submitTriggerInstalled = handlers.indexOf("onRegistrationSubmit") !== -1;
    diagnostics.cleanupTriggerInstalled = handlers.indexOf("cleanupOrphanUploads") !== -1;
    const rawMap = properties.getProperty(FORM_MAP_KEY);
    const map = rawMap ? JSON.parse(rawMap) : null;
    diagnostics.fastSubmit = {
      enabled: Boolean(getUsableFormMap(rawMap)),
      reason: map ? map.reason || "" : "map not built yet; run setup() or open the website",
      mapAgeMinutes: map ? Math.round((Date.now() - map.builtAt) / 60000) : null
    };
  } catch (err) {
    diagnostics.status = "error";
    diagnostics.propertiesError = err && err.message ? err.message : String(err);
  }

  timingsMs.total = Date.now() - started;
  return jsonResponse(diagnostics);
}

/**
 * POST handler.
 *   { action: "discard", fileId }
 *       -> trashes a direct upload the player replaced or removed, unless a
 *          registration already links to it
 *   { name, mobile, ..., photoFileId, documentFileId }
 *       -> registers the player (fallback when the website cannot post to the
 *          Form itself). `photo` / `document` data URLs are accepted instead of
 *          file ids when a direct upload failed.
 */
function doPost(e) {
  const data = parseRequestPayload(e);
  if (data && data.action === "discard") return handleDiscard(data);
  return handleRegistration(data);
}

function handleRegistration(data) {
  // Only files uploaded inline by this request; pre-uploaded files are kept on
  // failure so the browser can retry with the same file ids.
  const savedFiles = [];
  const lock = LockService.getScriptLock();
  const timings = createTimings();
  const skipped = [];
  let locked = false;
  let submitted = false;

  try {
    validateRegistration(data);
    const submissionId = data.submissionId == null ? "" : String(data.submissionId);
    if (submissionId && !isValidSubmissionId(submissionId)) {
      throw new Error("Invalid submission id.");
    }

    // One Script Properties read serves the retry check, the duplicate index
    // and the Form entry map.
    const properties = PropertiesService.getScriptProperties();
    const snapshot = properties.getProperties();
    timings.mark("readProperties");

    // A retry of a submission that was already saved (its response was lost
    // on the way back to the browser) must not create a second registration.
    if (submissionId && snapshot[SUBMISSION_KEY_PREFIX + submissionId] != null) {
      return jsonResponse({ status: "success", alreadyRecorded: true });
    }

    let formMap = getUsableFormMap(snapshot[FORM_MAP_KEY]);
    let form = null;
    const openForm = function () {
      if (!form) form = FormApp.openById(GOOGLE_FORM_ID);
      return form;
    };

    // The cached map can predate an edit to the Form's Category choices;
    // re-read the Form once instead of rejecting a valid category.
    if (formMap && !mapHasChoice(formMap, "Category", data.category)) {
      formMap = getUsableFormMap(JSON.stringify(refreshFormMap()));
      timings.mark("refreshFormMap");
    }

    if (formMap) {
      validateChoiceAnswers(formMap, data);
    } else {
      // Fail before writing anything to Drive if the form is misconfigured.
      validateFormForFormApp(openForm());
    }

    // The website's own post to the Form failed with a network error, so it
    // may still have been recorded; do not save the player a second time.
    if (data.formResponseAttempted === true && hasExistingRegistration(openForm(), data.name, data.mobile)) {
      return jsonResponse({ status: "success", alreadyRecorded: true });
    }

    let indexedNames;
    if (snapshot[REGISTRATION_INDEX_READY_KEY]) {
      indexedNames = parseIndexedNames(snapshot[REGISTRATION_KEY_PREFIX + data.mobile]);
    } else {
      if (!ensureRegistrationIndex(openForm(), lock)) {
        return busyResponse();
      }
      indexedNames = readIndexedNames(properties, data.mobile);
    }

    // The index can only produce false positives (for example after an
    // organizer deletes a response), so a hit is confirmed against the Form.
    // That slow scan only runs for likely duplicates, never for new players.
    const normalizedName = normalizeRegistrationName(data.name);
    let staleIndexEntry = false;
    if (indexedNames.indexOf(normalizedName) !== -1) {
      if (hasExistingRegistration(openForm(), data.name, data.mobile)) {
        throw new Error(DUPLICATE_MESSAGE);
      }
      staleIndexEntry = true;
    }
    timings.mark("duplicateCheck");

    // Uploads run before taking the lock so concurrent registrations do not
    // queue behind each other's Drive writes.
    const photoUrl = resolveUpload(data, "photo", savedFiles);
    const documentUrl = resolveUpload(data, "document", savedFiles);
    timings.mark("files");

    const answers = buildAnswers(data, photoUrl, documentUrl);
    // Without a Form entry map the FormApp response is prepared outside the lock.
    let formAppResponse = formMap ? null : buildFormAppResponse(openForm(), answers, skipped);

    // Only the final checks and the submit are serialized, so the lock is
    // held for about a second instead of the whole request.
    locked = lock.tryLock(LOCK_WAIT_MS);
    timings.mark("lock");
    if (!locked) {
      trashFiles(savedFiles);
      return busyResponse();
    }

    if (submissionId && isSubmissionRecorded(submissionId)) {
      trashFiles(savedFiles);
      return jsonResponse({ status: "success", alreadyRecorded: true });
    }

    // A hit here that was not stale before the lock means the same player was
    // registered concurrently by another request.
    const currentNames = readIndexedNames(properties, data.mobile);
    if (!staleIndexEntry && currentNames.indexOf(normalizedName) !== -1) {
      throw new Error(DUPLICATE_MESSAGE);
    }

    let route = "formResponse";
    const outcome = formMap ? submitViaFormResponse(formMap, answers) : "rejected";
    // After an unknown outcome, resubmitting blindly could save the player twice.
    if (outcome === "unknown" && hasExistingRegistration(openForm(), data.name, data.mobile)) {
      route = "formResponse (confirmed)";
    } else if (outcome !== "saved") {
      route = "formApp";
      if (!formAppResponse) formAppResponse = buildFormAppResponse(openForm(), answers, skipped);
      formAppResponse.submit();
    }
    submitted = true;
    timings.mark("submit");

    const updates = {};
    if (currentNames.indexOf(normalizedName) === -1) {
      updates[REGISTRATION_KEY_PREFIX + data.mobile] = JSON.stringify(currentNames.concat([normalizedName]));
    }
    if (submissionId) {
      updates[SUBMISSION_KEY_PREFIX + submissionId] = new Date().toISOString();
    }
    try {
      properties.setProperties(updates);
    } catch (err) {
      console.error("Registration saved, but duplicate index / submission id were not updated: " + err);
    }
    timings.mark("recordProperties");

    if (skipped.length) {
      console.warn("Submitted, but these values had no matching form item: " + skipped.join(", "));
    }

    const timingsMs = timings.result();
    console.log("Registration saved via " + route + " in " + timingsMs.total + " ms " + JSON.stringify(timingsMs));
    return jsonResponse({ status: "success", route: route, skippedFields: skipped, timingsMs: timingsMs });
  } catch (err) {
    console.error(err);
    if (submitted) {
      // The Form response exists and links to these files; keep them.
      return jsonResponse({ status: "success" });
    }
    trashFiles(savedFiles);
    const body = { status: "error", message: err && err.message ? err.message : String(err) };
    if (err && err.code) body.code = err.code;
    return jsonResponse(body);
  } finally {
    if (locked) lock.releaseLock();
  }
}

function validateRegistration(data) {
  if (!data || typeof data.name !== "string" || !data.name.trim()) {
    throw new Error("Please enter your name.");
  }
  if (typeof data.mobile !== "string" || !/^[0-9]{10}$/.test(data.mobile)) {
    throw new Error("Please enter exactly 10 digits for your mobile number.");
  }
  if (CATEGORIES.indexOf(data.category) === -1) {
    throw new Error("Please select your category.");
  }
  if (TSHIRT_SIZES.indexOf(data.tshirtSize) === -1) {
    throw new Error("Please select your T-shirt size.");
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
}

function validateFormForFormApp(form) {
  const missing = findMissingTitles(form);
  if (missing.length) {
    throw new Error("Google Form is missing these question titles: " + missing.join(", "));
  }
  const wrongType = findWrongTypeFileLinkTitles(form);
  if (wrongType.length) {
    throw new Error(
      "Change these Google Form questions to Short answer so file links can be stored: " +
      wrongType.join(", ")
    );
  }
  const missingCategories = findMissingCategoryChoices(form);
  if (missingCategories.length) throw new Error(missingCategoryMessage(missingCategories));
}

// A value outside the Form's options would make the fast submit fail anyway.
function validateChoiceAnswers(formMap, data) {
  if (!mapHasChoice(formMap, "Category", data.category)) {
    throw new Error("Please select your category.");
  }
}

function mapHasChoice(formMap, title, value) {
  const entry = formMap.entries[title];
  return !entry || !entry.choices || entry.choices.indexOf(value) !== -1;
}

// CATEGORIES that the Form's "Category" question does not offer as a choice.
function findMissingCategoryChoices(form) {
  const item = findItem(form, "Category", FormApp.ItemType.LIST) ||
               findItem(form, "Category", FormApp.ItemType.MULTIPLE_CHOICE);
  if (!item) return [];
  const choiceItem = item.getType() === FormApp.ItemType.LIST ? item.asListItem() : item.asMultipleChoiceItem();
  const choices = choiceItem.getChoices().map(function (choice) { return choice.getValue(); });
  return CATEGORIES.filter(function (category) { return choices.indexOf(category) === -1; });
}

function missingCategoryMessage(missing) {
  return "Add these choices to the Google Form \"Category\" question: " + missing.join(", ");
}

function createTimings() {
  const started = Date.now();
  let last = started;
  const timings = {};
  return {
    mark: function (name) {
      const now = Date.now();
      timings[name] = now - last;
      last = now;
    },
    result: function () {
      timings.total = Date.now() - started;
      return timings;
    }
  };
}

function buildAnswers(data, photoUrl, documentUrl) {
  return [
    { title: "Name", type: "text", value: data.name },
    { title: "Age", type: "text", value: data.age },
    { title: "Date of Birth", type: "date", value: data.dob },
    { title: "Category", type: "choice", value: data.category },
    { title: "Mobile Number", type: "text", value: data.mobile },
    { title: "T-Shirt Size", type: "choice", value: data.tshirtSize },
    { title: "Comments", type: "text", value: data.comment },
    { title: "Display Photo", type: "text", value: photoUrl },
    { title: "Document", type: "text", value: documentUrl },
    {
      title: "Created Date", type: "text",
      value: Utilities.formatDate(new Date(), CREATED_DATE_TIMEZONE, CREATED_DATE_FORMAT)
    },
    { title: "Player Tournament Age", type: "text", value: formatAgeOn(data.dob, TOURNAMENT_AGE_CUTOFF) }
  ].map(function (answer) {
    answer.value = answer.value == null ? "" : String(answer.value);
    return answer;
  });
}

function buildFormAppResponse(form, answers, skipped) {
  const response = form.createResponse();
  answers.forEach(function (answer) {
    if (answer.type === "date") {
      addDate(response, form, answer.title, answer.value, skipped);
    } else if (answer.type === "choice") {
      addChoice(response, form, answer.title, answer.value, skipped);
    } else {
      addText(response, form, answer.title, answer.value, skipped);
    }
  });
  return response;
}

function isValidSubmissionId(id) {
  return /^[A-Za-z0-9-]{8,64}$/.test(id);
}

function isSubmissionRecorded(id) {
  return PropertiesService.getScriptProperties().getProperty(SUBMISSION_KEY_PREFIX + id) !== null;
}

function normalizeRegistrationName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function readIndexedNames(properties, mobile) {
  return parseIndexedNames(properties.getProperty(REGISTRATION_KEY_PREFIX + mobile));
}

function parseIndexedNames(raw) {
  if (!raw) return [];
  try {
    const names = JSON.parse(raw);
    return Array.isArray(names) ? names : [];
  } catch (err) {
    return [];
  }
}

/**
 * Builds the duplicate-check index from existing Form responses once. Returns
 * false if the lock could not be taken. The index is built under the lock so
 * it cannot miss a registration that is submitted at the same time.
 */
function ensureRegistrationIndex(form, lock) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(REGISTRATION_INDEX_READY_KEY)) return true;
  if (!lock.tryLock(LOCK_WAIT_MS)) return false;
  try {
    if (!properties.getProperty(REGISTRATION_INDEX_READY_KEY)) {
      buildRegistrationIndex(form, properties);
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}

function buildRegistrationIndex(form, properties) {
  const nameItem = findItemByTitle(form, "Name");
  const mobileItem = findItemByTitle(form, "Mobile Number");
  const index = {};
  if (nameItem && mobileItem) {
    form.getResponses().forEach(function (response) {
      const mobileAnswer = response.getResponseForItem(mobileItem);
      const nameAnswer = response.getResponseForItem(nameItem);
      if (!mobileAnswer || !nameAnswer) return;
      const key = REGISTRATION_KEY_PREFIX + String(mobileAnswer.getResponse()).trim();
      const name = normalizeRegistrationName(nameAnswer.getResponse());
      const names = index[key] || (index[key] = []);
      if (names.indexOf(name) === -1) names.push(name);
    });
  }

  const values = {};
  Object.keys(index).forEach(function (key) {
    values[key] = JSON.stringify(index[key]);
  });
  values[REGISTRATION_INDEX_READY_KEY] = new Date().toISOString();
  properties.setProperties(values);
}

/**
 * Run this from the Apps Script editor after deploying, and again after
 * deleting or editing Form responses, to rebuild the duplicate-check index.
 * Running it before registrations open means no player waits for the
 * one-time index build.
 */
function rebuildRegistrationIndex() {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    const properties = PropertiesService.getScriptProperties();
    Object.keys(properties.getProperties()).forEach(function (key) {
      if (key.indexOf(REGISTRATION_KEY_PREFIX) === 0 || key === REGISTRATION_INDEX_READY_KEY) {
        properties.deleteProperty(key);
      }
    });
    buildRegistrationIndex(FormApp.openById(GOOGLE_FORM_ID), properties);
    console.log("Registration index rebuilt.");
  } finally {
    lock.releaseLock();
  }
}

function busyResponse() {
  return jsonResponse({
    status: "error",
    retryable: true,
    message: "The registration service is busy. Please try again shortly."
  });
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

// One folder lookup per execution; the id is also cached across executions.
let uploadFolder = null;

function getUploadFolder() {
  if (uploadFolder) return uploadFolder;

  if (UPLOAD_FOLDER_ID) {
    uploadFolder = DriveApp.getFolderById(UPLOAD_FOLDER_ID);
    return uploadFolder;
  }

  const properties = PropertiesService.getScriptProperties();
  const cachedId = properties.getProperty(UPLOAD_FOLDER_ID_KEY);
  if (cachedId) {
    try {
      const cached = DriveApp.getFolderById(cachedId);
      if (!cached.isTrashed()) {
        uploadFolder = cached;
        return uploadFolder;
      }
    } catch (err) {
      // The cached folder was deleted; fall back to a search below.
    }
  }

  const folders = DriveApp.getRootFolder().getFoldersByName(UPLOAD_FOLDER_NAME);
  uploadFolder = folders.hasNext() ? folders.next() : DriveApp.getRootFolder().createFolder(UPLOAD_FOLDER_NAME);
  try {
    properties.setProperty(UPLOAD_FOLDER_ID_KEY, uploadFolder.getId());
  } catch (err) {
    console.warn("Could not cache upload folder id: " + err);
  }
  return uploadFolder;
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

/* ---------- Fast submission through the Form's public endpoint ---------- */

/**
 * Builds the map from question title to the Form's "entry.<id>" field names,
 * which lets a registration be saved with one HTTP POST to /formResponse
 * instead of ~40 FormApp calls. Takes a few seconds, so it runs from the
 * website's warm-up request (refreshFormMapIfStale) or from the editor.
 */
function buildFormMap(form) {
  const map = { builtAt: Date.now(), fastSubmit: false, entries: {} };
  try {
    const missing = findMissingTitles(form);
    if (missing.length) throw new Error("missing question titles: " + missing.join(", "));
    if (findWrongTypeFileLinkTitles(form).length) throw new Error("file link questions must be Short answer");
    const missingCategories = findMissingCategoryChoices(form);
    if (missingCategories.length) throw new Error(missingCategoryMessage(missingCategories));
    if (form.collectsEmail()) throw new Error("the form collects email addresses");
    if (!form.isAcceptingResponses()) throw new Error("the form is not accepting responses");
    try {
      if (form.requiresLogin()) throw new Error("the form requires sign-in");
    } catch (err) {
      // requiresLogin() is only available to Google Workspace forms.
      if (/sign-in/.test(err.message)) throw err;
    }

    const publishedUrl = form.getPublishedUrl();
    if (!/\/viewform/.test(publishedUrl)) throw new Error("unexpected published URL " + publishedUrl);
    map.url = publishedUrl.replace(/\/viewform.*$/, "/formResponse");

    const index = getItemIndex(form);
    const pageBreaks = index.all.filter(function (entry) {
      return entry.type === FormApp.ItemType.PAGE_BREAK;
    }).length;
    if (pageBreaks) {
      const pages = [];
      for (let i = 0; i <= pageBreaks; i++) pages.push(i);
      map.pageHistory = pages.join(",");
    }

    buildAnswers({}, "", "").forEach(function (answer) {
      map.entries[answer.title] = describeFormEntry(form, answer);
    });
    // A required question the website does not fill in would make Google
    // reject every fast submission, which the website cannot see.
    const expected = {};
    EXPECTED_TITLES.forEach(function (title) { expected[title.toLowerCase()] = true; });
    index.all.forEach(function (entry) {
      if (expected[entry.title.trim().toLowerCase()]) return;
      if (isRequiredItem(entry.item, entry.type)) {
        throw new Error("required question \"" + entry.title + "\" is not filled in by the website");
      }
    });
    map.fastSubmit = true;
  } catch (err) {
    map.reason = err && err.message ? err.message : String(err);
  }
  return map;
}

// Picks the same item the FormApp path would use and reads its entry id from
// a pre-filled link.
function describeFormEntry(form, answer) {
  const types = FormApp.ItemType;
  const candidates = answer.type === "date" ? [types.DATE]
    : answer.type === "choice" ? [types.MULTIPLE_CHOICE, types.LIST]
    : [types.TEXT, types.PARAGRAPH_TEXT];

  for (let i = 0; i < candidates.length; i++) {
    const item = findItem(form, answer.title, candidates[i]);
    if (!item) continue;

    const entry = { type: String(candidates[i]), required: isRequiredItem(item, candidates[i]) };
    let itemResponse;
    if (candidates[i] === types.DATE) {
      const dateItem = item.asDateItem();
      if (!dateItem.includesYear()) throw new Error("\"" + answer.title + "\" must include the year");
      itemResponse = dateItem.createResponse(new Date(2000, 0, 1));
    } else if (candidates[i] === types.TEXT) {
      itemResponse = item.asTextItem().createResponse("x");
    } else if (candidates[i] === types.PARAGRAPH_TEXT) {
      itemResponse = item.asParagraphTextItem().createResponse("x");
    } else {
      const choiceItem = candidates[i] === types.LIST ? item.asListItem() : item.asMultipleChoiceItem();
      entry.choices = choiceItem.getChoices().map(function (choice) { return choice.getValue(); });
      if (!entry.choices.length) throw new Error("\"" + answer.title + "\" has no choices");
      itemResponse = choiceItem.createResponse(entry.choices[0]);
    }

    const prefilledUrl = form.createResponse().withItemResponse(itemResponse).toPrefilledUrl();
    const match = /[?&]entry\.(\d+)=/.exec(prefilledUrl);
    if (!match) throw new Error("could not read the entry id of \"" + answer.title + "\"");
    entry.id = match[1];
    return entry;
  }
  throw new Error("\"" + answer.title + "\" has an unsupported question type");
}

// Items that are not questions can never be required.
const NON_QUESTION_TYPES = ["SECTION_HEADER", "PAGE_BREAK", "IMAGE", "VIDEO"];
const REQUIRED_CASTS = {
  TEXT: "asTextItem", PARAGRAPH_TEXT: "asParagraphTextItem", MULTIPLE_CHOICE: "asMultipleChoiceItem",
  LIST: "asListItem", CHECKBOX: "asCheckboxItem", DATE: "asDateItem", DATETIME: "asDateTimeItem",
  TIME: "asTimeItem", DURATION: "asDurationItem", SCALE: "asScaleItem", GRID: "asGridItem",
  CHECKBOX_GRID: "asCheckboxGridItem", RATING: "asRatingItem"
};

// Unknown question types (e.g. File upload) are treated as required.
function isRequiredItem(item, type) {
  const name = String(type);
  if (NON_QUESTION_TYPES.indexOf(name) !== -1) return false;
  const cast = REQUIRED_CASTS[name];
  if (!cast || typeof item[cast] !== "function") return true;
  return item[cast]().isRequired();
}

function getUsableFormMap(raw) {
  if (!raw) return null;
  try {
    const map = JSON.parse(raw);
    if (!map || !map.fastSubmit || !map.url || !map.entries) return null;
    return Date.now() - map.builtAt < FORM_MAP_MAX_AGE_MS ? map : null;
  } catch (err) {
    return null;
  }
}

/**
 * Run from the Apps Script editor after editing Form questions so new
 * registrations immediately use the updated entry ids.
 */
function refreshFormMap() {
  const map = buildFormMap(FormApp.openById(GOOGLE_FORM_ID));
  PropertiesService.getScriptProperties().setProperty(FORM_MAP_KEY, JSON.stringify(map));
  console.log(map.fastSubmit
    ? "Fast submission enabled: " + map.url
    : "Fast submission disabled (" + map.reason + "); registrations use the slower FormApp path.");
  return map;
}

// Called from the website's warm-up GET, so the rebuild never delays a submit.
function refreshFormMapIfStale() {
  const raw = PropertiesService.getScriptProperties().getProperty(FORM_MAP_KEY);
  try {
    if (raw && Date.now() - JSON.parse(raw).builtAt < FORM_MAP_REFRESH_MS) return false;
  } catch (err) {
    // Rebuild a corrupt map.
  }
  // A soft guard so a burst of visitors does not rebuild the map in parallel.
  // The script lock is not used because registrations wait on it.
  const cache = CacheService.getScriptCache();
  if (cache.get(FORM_MAP_REFRESHING_KEY)) return false;
  cache.put(FORM_MAP_REFRESHING_KEY, "1", 60);
  refreshFormMap();
  return true;
}

// Returns "saved", "rejected" (Google refused it, so nothing was saved) or
// "unknown" (timeout / server error: the response may or may not exist).
function submitViaFormResponse(formMap, answers) {
  const fields = [];
  const add = function (name, value) {
    fields.push(encodeURIComponent(name) + "=" + encodeURIComponent(value));
  };

  for (let i = 0; i < answers.length; i++) {
    const answer = answers[i];
    if (!answer.value) continue;
    const entry = formMap.entries[answer.title];
    if (!entry) return "rejected";
    if (entry.type === String(FormApp.ItemType.DATE)) {
      const date = parseIsoDateUtc(answer.value);
      if (!date) continue;
      add("entry." + entry.id + "_year", date.getUTCFullYear());
      add("entry." + entry.id + "_month", date.getUTCMonth() + 1);
      add("entry." + entry.id + "_day", date.getUTCDate());
    } else {
      add("entry." + entry.id, answer.value);
    }
  }
  if (formMap.pageHistory) add("pageHistory", formMap.pageHistory);

  try {
    const response = UrlFetchApp.fetch(formMap.url, {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      payload: fields.join("&"),
      followRedirects: false,
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if (code === 200) return "saved";
    // Redirects (sign-in, closed form) and 4xx validation errors save nothing.
    if (code >= 300 && code < 500) {
      console.warn("Form endpoint rejected the response with HTTP " + code + "; falling back to FormApp.");
      return "rejected";
    }
    console.warn("Form endpoint returned HTTP " + code + "; the response may or may not be saved.");
  } catch (err) {
    console.warn("Form endpoint request failed; the response may or may not be saved: " + err);
  }
  return "unknown";
}

/* ---------- Direct-to-Drive uploads ---------- */

/**
 * Creates Drive resumable upload sessions in the upload folder. The website
 * PUTs each file straight to its session URL (Google's upload servers answer
 * CORS requests from the origin given here), so files never pass through
 * Apps Script and the player does not wait for it. Each URL takes one file
 * and expires after a week; unused URLs leave nothing behind.
 */
function createUploadSessions(kinds, count, origin) {
  const folderId = getUploadFolder().getId();
  const token = ScriptApp.getOAuthToken();
  const stamp = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyyMMdd-HHmmss");
  const requests = [];
  const requestKinds = [];
  kinds.forEach(function (kind) {
    for (let i = 0; i < count; i++) {
      requestKinds.push(kind);
      requests.push({
        url: DRIVE_UPLOAD_URL,
        method: "post",
        contentType: "application/json; charset=UTF-8",
        headers: { Authorization: "Bearer " + token, Origin: origin },
        payload: JSON.stringify({
          // Renamed with the player's details once a registration links it.
          name: PENDING_UPLOAD_PREFIX + stamp + "_" + slugify(UPLOAD_KINDS[kind]) + "_" +
            Utilities.getUuid().slice(0, 8),
          parents: [folderId]
        }),
        muteHttpExceptions: true
      });
    }
  });

  const sessions = {};
  kinds.forEach(function (kind) { sessions[kind] = []; });
  UrlFetchApp.fetchAll(requests).forEach(function (response, i) {
    const headers = response.getHeaders();
    const location = headers.Location || headers.location;
    if (response.getResponseCode() === 200 && location) {
      sessions[requestKinds[i]].push(location);
    } else {
      console.warn("Could not create an upload session: HTTP " + response.getResponseCode());
    }
  });
  return sessions;
}

// Everything the website needs to register without waiting on Apps Script.
function handlePrepare(params) {
  const result = { status: "ok", deployedVersion: DEPLOY_MARKER, serverTime: Date.now() };
  try {
    refreshFormMapIfStale();
  } catch (err) {
    console.warn("Could not refresh the Form entry map: " + err);
  }
  const map = getUsableFormMap(PropertiesService.getScriptProperties().getProperty(FORM_MAP_KEY));
  if (map) {
    result.formMap = { url: map.url, pageHistory: map.pageHistory || "", entries: map.entries };
  }

  const origin = String(params.origin || "");
  const kinds = String(params.kinds == null ? "photo,document" : params.kinds).split(",").filter(function (kind) {
    return UPLOAD_KINDS[kind];
  });
  if (kinds.length && /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && allowSessionRequest()) {
    const count = Math.min(Math.max(Number(params.count) || 2, 1), MAX_SESSIONS_PER_KIND);
    try {
      result.sessions = createUploadSessions(kinds, count, origin);
    } catch (err) {
      console.warn("Could not create upload sessions: " + err);
    }
  }
  return jsonResponse(result);
}

// Upload URLs accept files of any size, so how many can be handed out is
// capped. Over the cap the website simply uses the Apps Script path.
function allowSessionRequest() {
  const cache = CacheService.getScriptCache();
  const key = "sessionRequests:" + Math.floor(Date.now() / 60000);
  const count = Number(cache.get(key) || 0);
  if (count >= MAX_SESSION_REQUESTS_PER_MINUTE) {
    console.warn("Upload URL rate limit reached.");
    return false;
  }
  cache.put(key, String(count + 1), 120);
  return true;
}

// Background duplicate pre-check while the player is still filling in the form.
function handleCheck(params) {
  const name = typeof params.name === "string" ? params.name.trim().replace(/\s+/g, " ") : "";
  const mobile = String(params.mobile || "");
  if (!name || !/^[0-9]{10}$/.test(mobile)) {
    return jsonResponse({ status: "error", message: "Name and a 10-digit mobile are required." });
  }
  const names = readIndexedNames(PropertiesService.getScriptProperties(), mobile);
  const duplicate = names.indexOf(normalizeRegistrationName(name)) !== -1 &&
    hasExistingRegistration(FormApp.openById(GOOGLE_FORM_ID), name, mobile);
  return jsonResponse({
    status: "ok",
    duplicate: duplicate,
    message: duplicate ? DUPLICATE_MESSAGE : ""
  });
}

// Returns the Drive file for an id the website uploaded directly, or null if
// the id is not a file in the upload folder (or was trashed, unless allowed).
function findUploadedFile(fileId, allowTrashed) {
  if (typeof fileId !== "string" || !/^[-\w]{10,}$/.test(fileId)) return null;
  try {
    const file = DriveApp.getFileById(fileId);
    if (!allowTrashed && file.isTrashed()) return null;
    const folderId = getUploadFolder().getId();
    const parents = file.getParents();
    while (parents.hasNext()) {
      if (parents.next().getId() === folderId) return file;
    }
  } catch (err) {
    // Unknown or inaccessible id.
  }
  return null;
}

// The website calls this when a player replaces or removes a file that was
// already uploaded, so only the final copy stays in Drive. Only unclaimed
// ("pending_") files can be discarded, never one a registration links to.
// Anything missed here is trashed later by cleanupOrphanUploads.
function handleDiscard(data) {
  try {
    const file = findUploadedFile(data.fileId);
    if (!file) throw new Error("Unknown upload.");
    if (file.getName().indexOf(PENDING_UPLOAD_PREFIX) !== 0) {
      return jsonResponse({ status: "success", trashed: false });
    }
    file.setTrashed(true);
    return jsonResponse({ status: "success", trashed: true });
  } catch (err) {
    console.warn("Discard failed: " + err);
    return jsonResponse({ status: "error", message: err && err.message ? err.message : String(err) });
  }
}

// Returns the Drive link for the photo or document of a registration sent
// through Apps Script (the fallback path).
function resolveUpload(data, kind, savedFiles) {
  const title = UPLOAD_KINDS[kind];
  const fileId = data[kind + "FileId"];
  if (fileId) {
    const file = findUploadedFile(fileId);
    if (!file) throw new Error("Your " + title.toLowerCase() + " upload was not found. Please choose it again.");
    claimUpload(file, title, data.name, data.mobile, Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyyMMdd-HHmmss"));
    return driveFileLink(file.getId());
  }
  if (!data[kind]) return "";

  const upload = decodeUpload(title, data[kind]);
  const fileName = buildFilePrefix(data) + "_" + slugify(title) + getFileExtensionFromMime(upload.mimeType);
  const saved = getUploadFolder().createFile(Utilities.newBlob(upload.bytes, upload.mimeType, fileName));
  savedFiles.push(saved);
  return saved.getUrl();
}

function driveFileLink(id) {
  return "https://drive.google.com/file/d/" + id + "/view?usp=drivesdk";
}

function decodeUpload(title, value) {
  const match = typeof value === "string" && value.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error(title + " must be an image or PDF file.");

  const mimeType = match[1].toLowerCase();
  if (mimeType.indexOf("image/") !== 0 && mimeType !== "application/pdf") {
    throw new Error(title + " must be an image or PDF file (received " + mimeType + ").");
  }

  const bytes = Utilities.base64Decode(match[2]);
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new Error(title + " must be " + (MAX_UPLOAD_BYTES / (1024 * 1024)) + " MB or smaller.");
  }
  return { mimeType: mimeType, bytes: bytes };
}

function uploadOwner(mobile, name) {
  return [slugify(mobile), slugify(name)].filter(Boolean).join("_");
}

// Same pattern as inline uploads: <stamp>_<mobile>_<name>_<title><ext>.
function uploadFileName(stamp, owner, title, ext) {
  return [stamp, owner, slugify(title)].filter(Boolean).join("_") + ext;
}

// Gives a "pending_" upload its final name, which also stops it from being
// discarded. Files already claimed are left alone.
function claimUpload(file, title, name, mobile, stamp) {
  try {
    // A response may link a file the cleanup trashed while the page was open.
    if (file.isTrashed()) file.setTrashed(false);
    if (file.getName().indexOf(PENDING_UPLOAD_PREFIX) !== 0) return;
    const ext = getFileExtensionFromMime(String(file.getMimeType()).toLowerCase());
    file.setName(uploadFileName(stamp, uploadOwner(mobile, name), title, ext));
  } catch (err) {
    console.warn("Could not rename upload " + file.getId() + ": " + err);
  }
}

/**
 * Installable "On form submit" trigger (created by setup()). Registrations
 * sent straight from the website to the Form are finished here, after the
 * player has already seen the confirmation: linked uploads get their final
 * names and the duplicate-check index is updated.
 */
function onRegistrationSubmit(e) {
  const answers = {};
  e.response.getItemResponses().forEach(function (itemResponse) {
    answers[itemResponse.getItem().getTitle()] = String(itemResponse.getResponse() || "");
  });
  const name = (answers.Name || "").trim().replace(/\s+/g, " ");
  const mobile = (answers["Mobile Number"] || "").trim();
  const stamp = Utilities.formatDate(e.response.getTimestamp(), "Asia/Kolkata", "yyyyMMdd-HHmmss");

  FILE_LINK_TITLES.forEach(function (title) {
    extractDriveIds(answers[title] || "").forEach(function (id) {
      const file = findUploadedFile(id, true);
      if (file) claimUpload(file, title, name, mobile, stamp);
    });
  });

  if (!name || !/^[0-9]{10}$/.test(mobile)) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    const properties = PropertiesService.getScriptProperties();
    const names = readIndexedNames(properties, mobile);
    const normalized = normalizeRegistrationName(name);
    if (names.indexOf(normalized) === -1) {
      properties.setProperty(REGISTRATION_KEY_PREFIX + mobile, JSON.stringify(names.concat([normalized])));
    } else {
      // Already indexed: either the Apps Script path indexed it, or this is a
      // duplicate that slipped past the website's background pre-check.
      console.log("Registration for " + mobile + " / " + normalized + " was already indexed.");
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Trashes uploads that no Form response links to and that are older than
 * ORPHAN_UPLOAD_MAX_AGE_MS, i.e. uploads from players who never submitted.
 * Trashed files can be restored from Drive for 30 days.
 * Scheduled by setup(); can also be run from the editor.
 */
function cleanupOrphanUploads() {
  const form = FormApp.openById(GOOGLE_FORM_ID);
  const items = FILE_LINK_TITLES.map(function (title) {
    return findItemByTitle(form, title);
  }).filter(Boolean);
  const responses = form.getResponses();
  const referenced = {};
  responses.forEach(function (response) {
    items.forEach(function (item) {
      const answer = response.getResponseForItem(item);
      if (answer) extractDriveIds(String(answer.getResponse())).forEach(function (id) { referenced[id] = true; });
    });
  });
  if (responses.length && !Object.keys(referenced).length) {
    console.warn("No Drive links found in Form responses; skipping cleanup to be safe.");
    return 0;
  }

  const cutoff = Date.now() - ORPHAN_UPLOAD_MAX_AGE_MS;
  const files = getUploadFolder().getFiles();
  let removed = 0;
  while (files.hasNext()) {
    const file = files.next();
    if (referenced[file.getId()]) continue;
    if (file.getSize() > MAX_UPLOAD_BYTES) {
      // Upload URLs accept any size; delete oversized files permanently so
      // they do not keep using Drive storage from the trash.
      deleteFilePermanently(file);
    } else if (file.getDateCreated().getTime() <= cutoff) {
      file.setTrashed(true);
    } else {
      continue;
    }
    removed++;
  }
  console.log("Removed " + removed + " unused upload(s).");
  return removed;
}

function deleteFilePermanently(file) {
  const response = UrlFetchApp.fetch("https://www.googleapis.com/drive/v3/files/" + file.getId(), {
    method: "delete",
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() >= 300) file.setTrashed(true);
}

function extractDriveIds(text) {
  const ids = [];
  const pattern = /(?:\/d\/|[?&]id=)([-\w]{20,})/g;
  let match;
  while ((match = pattern.exec(text))) ids.push(match[1]);
  return ids;
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    if (handler === "cleanupOrphanUploads" || handler === "onRegistrationSubmit") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("cleanupOrphanUploads").timeBased().everyHours(1).create();
  ScriptApp.newTrigger("onRegistrationSubmit").forForm(GOOGLE_FORM_ID).onFormSubmit().create();
  console.log("Triggers installed: cleanupOrphanUploads every hour, onRegistrationSubmit on form submit.");
}

/**
 * Run once from the Apps Script editor after pasting the code (and after
 * every Form question change). Authorizes Drive, Forms, external requests and
 * triggers, then prepares everything a registration needs so no player pays
 * for one-time setup.
 */
function setup() {
  setupUploadFolder();
  if (!PropertiesService.getScriptProperties().getProperty(REGISTRATION_INDEX_READY_KEY)) {
    rebuildRegistrationIndex();
  }
  refreshFormMap();
  installTriggers();
}

// Parses YYYY-MM-DD as a UTC date; returns null for malformed or impossible dates.
function parseIsoDateUtc(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
  return date;
}

// Same month/day in another year; Feb 29 falls back to Feb 28 in non-leap years.
function sameDayInYearUtc(date, year) {
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

// Age on `onIso` as "X years, Y days" (same format as the website's Age),
// or "" when the DOB is missing, invalid or after that date.
function formatAgeOn(dobIso, onIso) {
  const dob = parseIsoDateUtc(dobIso);
  const on = parseIsoDateUtc(onIso);
  if (!dob || !on || dob > on) return "";

  let years = on.getUTCFullYear() - dob.getUTCFullYear();
  let lastBirthday = sameDayInYearUtc(dob, on.getUTCFullYear());
  if (lastBirthday > on) {
    years -= 1;
    lastBirthday = sameDayInYearUtc(dob, on.getUTCFullYear() - 1);
  }
  const days = Math.round((on - lastBirthday) / (24 * 60 * 60 * 1000));
  return years + (years === 1 ? " year, " : " years, ") +
         days + (days === 1 ? " day" : " days");
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

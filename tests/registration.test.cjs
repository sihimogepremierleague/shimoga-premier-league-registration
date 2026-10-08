const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");

const CATEGORIES = ["G/N Doubles", "30+ Men's Doubles", "40+ Men's Doubles", "50+ & 35+ Jumble Doubles"];
const TSHIRT_SIZES = ["S", "M", "L", "XL", "XXL"];
const PUBLISHED_URL = "https://docs.google.com/forms/d/e/pub-id/viewform";

const hmac = (value, key) => Array.from(crypto.createHmac("sha256", key).update(value).digest());
const webSafe = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

function createService({
  lockAvailable = true, failSubmit = false, failRecord = false,
  indexReady = false, existing = [], onLock = null, missingTitles = [],
  collectsEmail = false, formResponseStatus = 200, formResponseSaves = null, fetchThrows = false
} = {}) {
  const responses = [];
  const properties = indexReady ? { registrationIndexReady: "2026-10-06T00:00:00.000Z" } : {};
  const cache = {};
  const fetches = [];
  const triggers = [];
  let lockCalls = 0;
  let folderSearches = 0;
  const files = [];
  const events = [];
  const types = {
    TEXT: "TEXT", PARAGRAPH_TEXT: "PARAGRAPH_TEXT", DATE: "DATE", LIST: "LIST",
    MULTIPLE_CHOICE: "MULTIPLE_CHOICE", PAGE_BREAK: "PAGE_BREAK"
  };
  const titles = ["Name", "Age", "Date of Birth", "Category", "Mobile Number", "Comments", "Display Photo", "Document", "T-Shirt Size", "Created Date", "Player Tournament Age"]
    .filter((title) => !missingTitles.includes(title));
  const items = titles.map((title, index) => {
    const type = title === "Date of Birth" ? types.DATE
      : title === "Category" || title === "T-Shirt Size" ? types.LIST : types.TEXT;
    const choices = title === "Category" ? CATEGORIES : title === "T-Shirt Size" ? TSHIRT_SIZES : [];
    const item = {
      entryId: String(1000 + index),
      getTitle: () => title,
      getType: () => type,
      includesYear: () => true,
      getChoices: () => choices.map((value) => ({ getValue: () => value })),
      createResponse: (value) => ({ getItem: () => item, getResponse: () => value })
    };
    item.asTextItem = item.asParagraphTextItem = item.asDateItem = item.asListItem = item.asMultipleChoiceItem = () => item;
    return item;
  });
  const itemByTitle = (title) => items.find((item) => item.getTitle() === title);
  const prefillValue = (value) => (Object.prototype.toString.call(value) === "[object Date]" ? value.toISOString().slice(0, 10) : String(value));
  const form = {
    getTitle: () => "SPL Registration",
    isAcceptingResponses: () => true,
    collectsEmail: () => collectsEmail,
    requiresLogin: () => { throw new Error("Only available for Google Workspace"); },
    getPublishedUrl: () => PUBLISHED_URL,
    getItems: (type) => items.filter((item) => !type || item.getType() === type),
    getResponses: () => {
      events.push("scan");
      return responses;
    },
    createResponse: () => {
      const answers = [];
      const response = {
        withItemResponse: (answer) => {
          answers.push(answer);
          return response;
        },
        getItemResponses: () => answers,
        getResponseForItem: (item) => answers.find((answer) => answer.getItem() === item) || null,
        toPrefilledUrl: () => PUBLISHED_URL + "?usp=pp_url&" + answers
          .map((answer) => "entry." + answer.getItem().entryId + "=" + encodeURIComponent(prefillValue(answer.getResponse())))
          .join("&"),
        submit: () => {
          events.push("submit");
          if (failSubmit) throw new Error("Save failed");
          responses.push(response);
        }
      };
      return response;
    }
  };
  const folder = {
    getId: () => "folder-1",
    getName: () => "SPL Registration Uploads",
    getUrl: () => "https://drive.google.com/drive/folders/folder-1",
    isTrashed: () => false,
    getFiles: () => {
      const list = files.filter((file) => !file.trashed);
      let i = 0;
      return { hasNext: () => i < list.length, next: () => list[i++] };
    },
    createFile: (blob) => {
      events.push("upload");
      const id = "1DriveFileId" + String(files.length).padStart(12, "0");
      const file = {
        id,
        name: blob && blob.name,
        created: new Date(),
        trashed: false,
        getId: () => id,
        getUrl: () => "https://drive.google.com/file/d/" + id + "/view?usp=drivesdk",
        getDateCreated: () => file.created,
        setName: (name) => { events.push("rename"); file.name = name; },
        setTrashed: (value) => { file.trashed = value; }
      };
      files.push(file);
      return file;
    }
  };
  // Simulates Google's /formResponse endpoint: a 200 stores the response.
  function formResponseFetch(url, options) {
    events.push("fetch");
    const fields = Object.fromEntries(new URLSearchParams(options.payload));
    fetches.push({ url, options, fields });
    if (formResponseSaves === null ? formResponseStatus === 200 : formResponseSaves) {
      const response = form.createResponse();
      for (const item of items) {
        const value = item.getType() === types.DATE
          ? fields["entry." + item.entryId + "_year"] && [
            fields["entry." + item.entryId + "_year"],
            fields["entry." + item.entryId + "_month"].padStart(2, "0"),
            fields["entry." + item.entryId + "_day"].padStart(2, "0")
          ].join("-")
          : fields["entry." + item.entryId];
        if (value) response.withItemResponse(item.createResponse(value));
      }
      responses.push(response);
    }
    if (fetchThrows) throw new Error("Timeout: https://docs.google.com/forms/...");
    return { getResponseCode: () => formResponseStatus };
  }
  const context = vm.createContext({
    console: { error() {}, warn() {}, log() {} },
    FormApp: { openById: () => { events.push("open"); return form; }, ItemType: types },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (key in properties ? properties[key] : null),
        getProperties: () => ({ ...properties }),
        setProperty: (key, value) => {
          if (failRecord) throw new Error("Properties unavailable");
          properties[key] = value;
        },
        setProperties: (values) => {
          if (failRecord && Object.keys(values).some((key) => key.startsWith("submission:"))) {
            throw new Error("Properties unavailable");
          }
          Object.assign(properties, values);
        },
        deleteProperty: (key) => { delete properties[key]; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (key in cache ? cache[key] : null),
        put: (key, value) => { cache[key] = value; }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          events.push("lock");
          if (onLock) onLock(++lockCalls, api);
          return lockAvailable;
        },
        waitLock: () => { events.push("lock"); },
        releaseLock: () => { events.push("release"); }
      })
    },
    DriveApp: {
      getFolderById: () => folder,
      getFileById: (id) => files.find((file) => file.id === id),
      getRootFolder: () => ({
        getFoldersByName: () => {
          folderSearches++;
          return { hasNext: () => true, next: () => folder };
        }
      })
    },
    UrlFetchApp: { fetch: formResponseFetch },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (trigger) => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: (handler) => ({
        timeBased: () => ({
          everyHours: (hours) => ({
            create: () => triggers.push({ getHandlerFunction: () => handler, hours })
          })
        })
      })
    },
    Utilities: {
      formatDate: (date, timeZone, format) => (format === "yyyy-MM-dd HH:mm:ss" && timeZone === "Asia/Kolkata"
        ? "2026-10-06 12:00:00" : "20261006-120000"),
      base64Decode: (value) => Buffer.from(value, "base64"),
      base64EncodeWebSafe: webSafe,
      computeHmacSha256Signature: hmac,
      getUuid: () => crypto.randomUUID(),
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name })
    },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (text) => ({ setMimeType() {}, text })
    }
  });
  function addResponse(name, mobile) {
    const response = form.createResponse();
    response.withItemResponse(itemByTitle("Name").createResponse(name));
    response.withItemResponse(itemByTitle("Mobile Number").createResponse(mobile));
    responses.push(response);
  }
  existing.forEach(([name, mobile]) => addResponse(name, mobile));
  vm.runInContext(source, context);
  const api = {
    files, responses, events, properties, fetches, triggers, addResponse,
    folderSearches: () => folderSearches,
    post: (data) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text),
    get: (parameter) => JSON.parse(context.doGet({ parameter }).text),
    rebuildIndex: () => context.rebuildRegistrationIndex(),
    run: (name) => context[name](),
    sign: (info) => {
      const payload = JSON.stringify(info);
      return { payload, sig: webSafe(hmac(payload, properties.uploadTokenSecret)) };
    }
  };
  return api;
}

const payload = {
  name: "Test Player",
  mobile: "0123456789",
  age: "30 years, 0 days",
  dob: "1996-10-06",
  category: "G/N Doubles",
  tshirtSize: "M",
  photo: "data:image/jpeg;base64,dGVzdA==",
  document: "data:application/pdf;base64,dGVzdA=="
};

const answerFor = (service, title) => {
  const answer = service.responses[0].getItemResponses()
    .find((item) => item.getItem().getTitle() === title);
  return answer ? answer.getResponse() : undefined;
};

test("Created Date is recorded as the IST submission time", () => {
  const service = createService();
  assert.equal(service.post(payload).status, "success");
  assert.equal(answerFor(service, "Created Date"), "2026-10-06 12:00:00");
});

test("Player Tournament Age is the age on 5 Jun 2027 calculated from DOB", () => {
  const cases = [
    ["1997-06-05", "30 years, 0 days"],
    ["1997-06-06", "29 years, 364 days"],
    ["1996-10-06", "30 years, 242 days"],
    ["1987-01-01", "40 years, 155 days"],
    ["2000-02-29", "27 years, 97 days"],
    ["2026-06-05", "1 year, 0 days"],
    ["2027-06-04", "0 years, 1 day"]
  ];
  for (const [dob, expected] of cases) {
    const service = createService();
    assert.equal(service.post({ ...payload, dob }).status, "success");
    assert.equal(answerFor(service, "Player Tournament Age"), expected, dob);
  }

  for (const dob of ["", "1996-02-30", "06-10-1996", "2027-06-06"]) {
    const service = createService();
    assert.equal(service.post({ ...payload, dob }).status, "success");
    assert.equal(answerFor(service, "Player Tournament Age"), undefined, dob);
  }
});

test("missing Created Date / Player Tournament Age questions are reported before any writes", () => {
  const service = createService({ missingTitles: ["Created Date", "Player Tournament Age"] });
  const result = service.post(payload);
  assert.equal(result.status, "error");
  assert.match(result.message, /missing these question titles: Created Date, Player Tournament Age/);
  assert.equal(service.files.length, 0);
  assert.equal(service.responses.length, 0);
});

test("only exactly ten ASCII digits are accepted before any writes", () => {
  for (const mobile of ["", "123456789", "12345678901", "12345abcde", "+9123456789", "123 456789", 1234567890]) {
    const service = createService();
    assert.equal(service.post({ ...payload, mobile }).status, "error");
    assert.equal(service.responses.length, 0);
    assert.equal(service.files.length, 0);
    assert.deepEqual(service.events, []);
  }
  assert.equal(createService().post(payload).status, "success");
});

test("T-shirt size must be one of S, M, L, XL, XXL before any writes", () => {
  for (const tshirtSize of [undefined, "", "m", "XS", "XXXL", " M", 1]) {
    const service = createService();
    const result = service.post({ ...payload, tshirtSize });
    assert.equal(result.status, "error");
    assert.match(result.message, /T-shirt size/);
    assert.deepEqual(service.events, []);
    assert.equal(service.files.length, 0);
  }
  for (const tshirtSize of ["S", "M", "L", "XL", "XXL"]) {
    const service = createService();
    assert.equal(service.post({ ...payload, tshirtSize }).status, "success");
    const answer = service.responses[0].getItemResponses()
      .find((item) => item.getItem().getTitle() === "T-Shirt Size");
    assert.equal(answer && answer.getResponse(), tshirtSize);
  }
});

test("uploads are limited to 5 MB each and oversized files are not kept", () => {
  const dataUrl = (type, size) => "data:" + type + ";base64," + Buffer.alloc(size).toString("base64");
  const limit = 5 * 1024 * 1024;
  const ok = createService();
  assert.equal(ok.post({ ...payload, photo: dataUrl("image/jpeg", limit), document: dataUrl("application/pdf", limit) }).status, "success");
  assert.equal(ok.files.length, 2);

  for (const field of ["photo", "document"]) {
    const service = createService();
    const type = field === "photo" ? "image/jpeg" : "application/pdf";
    const result = service.post({ ...payload, [field]: dataUrl(type, limit + 1) });
    assert.equal(result.status, "error");
    assert.match(result.message, /5 MB or smaller/);
    assert.equal(service.responses.length, 0);
    assert.ok(service.files.every((file) => file.trashed));
  }
});

test("blank names are rejected", () => {
  const service = createService();
  assert.equal(service.post({ ...payload, name: "  " }).status, "error");
  assert.equal(service.files.length, 0);
});

test("name is limited to 50 and comments to 250 characters before any writes", () => {
  for (const data of [
    { ...payload, name: "a".repeat(51) },
    { ...payload, comment: "c".repeat(251) },
    { ...payload, comment: 42 }
  ]) {
    const service = createService();
    assert.equal(service.post(data).status, "error");
    assert.deepEqual(service.events, []);
    assert.equal(service.files.length, 0);
  }
  const service = createService();
  assert.equal(service.post({ ...payload, name: "a".repeat(50), comment: "c".repeat(250) }).status, "success");
  assert.equal(createService().post({ ...payload, name: "  " + "a".repeat(50) + "  " }).status, "success");
});

test("normalized name and mobile pair is unique against existing responses", () => {
  const service = createService();
  assert.equal(service.post(payload).status, "success");
  const duplicate = service.post({ ...payload, name: "  TEST   player  " });
  assert.equal(duplicate.status, "error");
  assert.match(duplicate.message, /already exists/);
  assert.equal(service.responses.length, 1);
  assert.equal(service.files.length, 2);
  assert.deepEqual(service.events, [
    // first request: one-time index build, uploads outside the lock, short locked submit
    "open", "lock", "scan", "release", "upload", "upload", "lock", "submit", "release",
    // duplicate: index hit is confirmed against the Form before any upload
    "open", "scan"
  ]);
});

test("new registrations use the index and never scan Form responses", () => {
  const service = createService({ indexReady: true, existing: [["Old Player", "1111111111"]] });
  assert.equal(service.post(payload).status, "success");
  assert.equal(service.post({ ...payload, mobile: "2222222222" }).status, "success");
  assert.ok(!service.events.includes("scan"));
  assert.deepEqual(service.events.slice(0, 5), ["open", "upload", "upload", "lock", "submit"]);
});

test("index is built once from existing responses so earlier registrations stay unique", () => {
  const service = createService({ existing: [["Test Player", "0123456789"], ["Other", "0123456789"]] });
  const duplicate = service.post({ ...payload, name: "test PLAYER" });
  assert.equal(duplicate.status, "error");
  assert.match(duplicate.message, /already exists/);
  assert.equal(service.files.length, 0);
  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player", "other"]);
  assert.ok(service.properties.registrationIndexReady);

  service.events.length = 0;
  assert.equal(service.post({ ...payload, name: "Third Player" }).status, "success");
  assert.ok(!service.events.includes("scan"));
  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player", "other", "third player"]);
});

test("a stale index entry for a deleted response does not block registration", () => {
  const service = createService({ indexReady: true });
  service.properties["reg:0123456789"] = JSON.stringify(["test player"]);
  const result = service.post(payload);
  assert.equal(result.status, "success");
  assert.equal(service.responses.length, 1);
  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player"]);
});

test("a concurrent registration of the same player is caught under the lock", () => {
  const service = createService({
    indexReady: true,
    onLock: (call, api) => {
      // Another request registers the same player while this one uploads.
      if (call === 1) api.properties["reg:0123456789"] = JSON.stringify(["test player"]);
    }
  });
  const result = service.post(payload);
  assert.equal(result.status, "error");
  assert.match(result.message, /already exists/);
  assert.equal(service.responses.length, 0);
  assert.ok(service.files.length === 2 && service.files.every((file) => file.trashed));
  assert.equal(service.events.at(-1), "release");
});

test("rebuildRegistrationIndex replaces stale entries with current responses", () => {
  const service = createService({ indexReady: true, existing: [["Kept Player", "3333333333"]] });
  service.properties["reg:0123456789"] = JSON.stringify(["deleted player"]);
  service.properties["submission:keep-this-1"] = "x";
  service.rebuildIndex();
  assert.equal(service.properties["reg:0123456789"], undefined);
  assert.deepEqual(JSON.parse(service.properties["reg:3333333333"]), ["kept player"]);
  assert.equal(service.properties["submission:keep-this-1"], "x");
  assert.ok(service.properties.registrationIndexReady);
});

test("upload folder is looked up once and its id is cached", () => {
  const service = createService();
  service.post(payload);
  service.post({ ...payload, mobile: "9876543210" });
  assert.equal(service.folderSearches(), 1);
  assert.equal(service.properties.uploadFolderId, "folder-1");
});

test("same mobile with another name and same name with another mobile are allowed", () => {
  const service = createService();
  for (const data of [payload, { ...payload, name: "Second Player" }, { ...payload, mobile: "9876543210" }]) {
    assert.equal(service.post(data).status, "success");
  }
  assert.equal(service.responses.length, 3);
});

test("lock contention fails without writes or releasing someone else's lock", () => {
  const service = createService({ lockAvailable: false });
  assert.match(service.post(payload).message, /busy/);
  assert.deepEqual(service.events, ["open", "lock"]);
  assert.equal(service.files.length, 0);

  const ready = createService({ lockAvailable: false, indexReady: true });
  assert.match(ready.post(payload).message, /busy/);
  assert.equal(ready.responses.length, 0);
  assert.ok(ready.files.every((file) => file.trashed));
  assert.ok(!ready.events.includes("release"));
});

test("failed submission cleans up files and releases lock", () => {
  const service = createService({ failSubmit: true });
  assert.equal(service.post(payload).status, "error");
  assert.equal(service.responses.length, 0);
  assert.equal(service.files.length, 2);
  assert.ok(service.files.every((file) => file.trashed));
  assert.equal(service.events.at(-1), "release");
});

test("retrying a saved submissionId succeeds without another response or upload", () => {
  const service = createService();
  const data = { ...payload, submissionId: "4f7c2a8e-1b2c-4d5e-8f90-123456789abc" };
  assert.equal(service.post(data).status, "success");
  const eventsAfterFirst = service.events.length;
  const retry = service.post(data);
  assert.equal(retry.status, "success");
  assert.equal(retry.alreadyRecorded, true);
  assert.equal(service.responses.length, 1);
  assert.equal(service.files.length, 2);
  assert.deepEqual(service.events.slice(eventsAfterFirst), []);
});

test("a new submissionId for the same player is still rejected as a duplicate", () => {
  const service = createService();
  assert.equal(service.post({ ...payload, submissionId: "aaaaaaaa-1111" }).status, "success");
  const second = service.post({ ...payload, submissionId: "bbbbbbbb-2222" });
  assert.equal(second.status, "error");
  assert.match(second.message, /already exists/);
  assert.equal(service.responses.length, 1);
});

test("invalid submissionIds are rejected before any writes", () => {
  for (const submissionId of ["short", "has space 12345", "x".repeat(65), "<script>alert(1)</script>"]) {
    const service = createService();
    assert.equal(service.post({ ...payload, submissionId }).status, "error");
    assert.deepEqual(service.events, []);
  }
});

test("submission status lookup reports recorded ids without opening the form", () => {
  const service = createService();
  const submissionId = "cccccccc-3333";
  assert.equal(service.get({ submissionId }).status, "not_found");
  service.post({ ...payload, submissionId });
  const eventsBefore = service.events.length;
  assert.deepEqual(service.get({ submissionId }), { status: "success", submissionId });
  assert.equal(service.get({ submissionId: "bad id" }).status, "error");
  assert.equal(service.events.length, eventsBefore);
});

test("plain GET is a fast liveness check that does not touch Forms or Drive", () => {
  const service = createService();
  const body = service.get({});
  assert.equal(body.status, "ok");
  assert.match(body.deployedVersion, /\S/);
  assert.equal(body.items, undefined);
  assert.deepEqual(service.events, []);
});

test("diagnostics GET reports configuration, counts and timings", () => {
  const service = createService();
  service.post({ ...payload, submissionId: "dddddddd-4444" });
  const body = service.get({ diagnostics: "1" });
  assert.equal(body.status, "ok");
  assert.deepEqual(body.missingTitles, []);
  assert.deepEqual(body.wrongTypeTitles, []);
  assert.equal(body.responseCount, 1);
  assert.equal(body.recordedSubmissionIds, 1);
  assert.equal(body.registrationIndexReady, true);
  assert.equal(body.indexedMobileNumbers, 1);
  assert.equal(typeof body.timingsMs.total, "number");
});

test("failing to record the submissionId after saving still reports success and keeps files", () => {
  const service = createService({ failRecord: true });
  const result = service.post({ ...payload, submissionId: "eeeeeeee-5555" });
  assert.equal(result.status, "success");
  assert.equal(service.responses.length, 1);
  assert.ok(service.files.every((file) => !file.trashed));
  assert.equal(service.events.at(-1), "release");
});

test("a submissionId saved by a parallel retry is not submitted twice", () => {
  const submissionId = "ffffffff-6666";
  const service = createService({
    indexReady: true,
    onLock: (call, api) => {
      if (call === 1) api.properties["submission:" + submissionId] = "saved";
    }
  });
  const result = service.post({ ...payload, submissionId });
  assert.equal(result.status, "success");
  assert.equal(result.alreadyRecorded, true);
  assert.equal(service.responses.length, 0);
  assert.ok(service.files.every((file) => file.trashed));
});

test("busy lock is reported as retryable", () => {
  const result = createService({ lockAvailable: false }).post(payload);
  assert.equal(result.status, "error");
  assert.equal(result.retryable, true);
});

/* ---------- Background uploads and fast /formResponse submit ---------- */

const { photo: _photo, document: _document, ...textPayload } = payload;

function uploadFor(service, kind, extra = {}) {
  const file = kind === "photo" ? payload.photo : payload.document;
  return service.post({ action: "upload", kind, file, name: payload.name, mobile: payload.mobile, ...extra });
}

function fastService(options) {
  const service = createService({ indexReady: true, ...options });
  assert.equal(service.get({ warm: "1" }).status, "ok");
  service.events.length = 0;
  return service;
}

test("background upload saves one named file and returns a signed token", () => {
  const service = createService();
  const result = uploadFor(service, "photo");
  assert.equal(result.status, "success");
  assert.equal(service.files.length, 1);
  assert.equal(service.files[0].name, "20261006-120000_0123456789_test-player_display-photo.jpg");
  const info = JSON.parse(result.upload.payload);
  assert.equal(info.kind, "photo");
  assert.equal(info.url, service.files[0].getUrl());
  assert.ok(result.upload.sig);
  assert.deepEqual(service.events, ["upload"]);
});

test("background upload validates kind, type and size before writing", () => {
  const big = "data:image/jpeg;base64," + Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
  for (const data of [
    { action: "upload", kind: "resume", file: payload.photo },
    { action: "upload", kind: "photo", file: "data:text/html;base64,dGVzdA==" },
    { action: "upload", kind: "photo", file: "not a data url" },
    { action: "upload", kind: "document", file: big }
  ]) {
    const service = createService();
    assert.equal(service.post(data).status, "error");
    assert.equal(service.files.length, 0);
  }
});

test("registration with upload tokens links the pre-uploaded files without uploading again", () => {
  const service = createService({ indexReady: true });
  const photo = uploadFor(service, "photo").upload;
  const documentUpload = uploadFor(service, "document").upload;
  service.events.length = 0;
  const result = service.post({ ...textPayload, photoUpload: photo, documentUpload });
  assert.equal(result.status, "success");
  assert.ok(!service.events.includes("upload"));
  assert.ok(!service.events.includes("rename"));
  assert.equal(answerFor(service, "Display Photo"), service.files[0].getUrl());
  assert.equal(answerFor(service, "Document"), service.files[1].getUrl());
});

test("uploads made before the final name or mobile was typed are renamed at submit", () => {
  const service = createService({ indexReady: true });
  const photo = uploadFor(service, "photo", { name: "Te", mobile: "" }).upload;
  assert.equal(service.files[0].name, "20261006-120000_te_display-photo.jpg");
  assert.equal(service.post({ ...textPayload, photoUpload: photo, document: payload.document }).status, "success");
  assert.equal(service.files[0].name, "20261006-120000_0123456789_test-player_display-photo.jpg");
});

test("tampered, mismatched or expired upload tokens are rejected without saving", () => {
  const service = createService({ indexReady: true });
  const photo = uploadFor(service, "photo").upload;
  const info = JSON.parse(photo.payload);
  const expired = service.sign({ ...info, ts: Date.now() - 21 * 60 * 60 * 1000 });
  const forged = { payload: JSON.stringify({ ...info, id: "someone-elses-file" }), sig: photo.sig };
  for (const data of [
    { ...textPayload, photoUpload: forged },
    { ...textPayload, photoUpload: expired },
    { ...textPayload, documentUpload: photo },
    { ...textPayload, photoUpload: { payload: photo.payload } }
  ]) {
    const result = service.post(data);
    assert.equal(result.status, "error");
    assert.equal(result.code, "upload_invalid");
  }
  assert.equal(service.responses.length, 0);
  assert.ok(service.files.every((file) => !file.trashed), "pre-uploaded files are kept for a retry");
});

test("warm-up GET builds the Form entry map once; plain GET does not", () => {
  const service = createService();
  service.get({});
  assert.equal(service.properties.formMap, undefined);

  service.get({ warm: "1" });
  const map = JSON.parse(service.properties.formMap);
  assert.equal(map.fastSubmit, true);
  assert.equal(map.url, "https://docs.google.com/forms/d/e/pub-id/formResponse");
  assert.deepEqual(map.entries["Date of Birth"], { type: "DATE", id: "1002" });
  assert.deepEqual(map.entries.Category.choices, CATEGORIES);

  service.events.length = 0;
  service.get({ warm: "1" });
  assert.deepEqual(service.events, [], "a fresh map is not rebuilt");
});

test("fast submit posts one /formResponse request without opening the Form", () => {
  const service = fastService();
  const photo = uploadFor(service, "photo").upload;
  const documentUpload = uploadFor(service, "document").upload;
  service.events.length = 0;
  const result = service.post({ ...textPayload, submissionId: "abcdefgh-1234", photoUpload: photo, documentUpload });
  assert.equal(result.status, "success");
  assert.equal(result.route, "formResponse");
  assert.deepEqual(service.events, ["lock", "fetch", "release"]);
  assert.equal(typeof result.timingsMs.total, "number");

  const { url, options, fields } = service.fetches[0];
  assert.equal(url, "https://docs.google.com/forms/d/e/pub-id/formResponse");
  assert.equal(options.followRedirects, false);
  assert.equal(fields["entry.1000"], "Test Player");
  assert.equal(fields["entry.1002_year"], "1996");
  assert.equal(fields["entry.1002_month"], "10");
  assert.equal(fields["entry.1002_day"], "6");
  assert.equal(fields["entry.1003"], "G/N Doubles");
  assert.equal(fields["entry.1006"], service.files[0].getUrl());
  assert.equal(fields["entry.1009"], "2026-10-06 12:00:00");
  assert.equal(fields["entry.1010"], "30 years, 242 days");
  assert.equal(fields["entry.1005"], undefined, "empty comments are not sent");

  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player"]);
  assert.ok(service.properties["submission:abcdefgh-1234"]);
  const duplicate = service.post({ ...textPayload, photoUpload: photo, documentUpload });
  assert.match(duplicate.message, /already exists/);
});

test("fast submit falls back to FormApp when the Form endpoint rejects the response", () => {
  const service = fastService({ formResponseStatus: 400 });
  const result = service.post(payload);
  assert.equal(result.status, "success");
  assert.equal(result.route, "formApp");
  assert.deepEqual(service.events, ["upload", "upload", "lock", "fetch", "open", "submit", "release"]);
  assert.equal(service.responses.length, 1);
  assert.equal(answerFor(service, "Player Tournament Age"), "30 years, 242 days");
});

test("fast submit stays off when the Form collects email addresses", () => {
  const service = fastService({ collectsEmail: true });
  assert.match(JSON.parse(service.properties.formMap).reason, /email/);
  const result = service.post(payload);
  assert.equal(result.route, "formApp");
  assert.ok(!service.events.includes("fetch"));
  assert.equal(service.get({ diagnostics: "1" }).fastSubmit.enabled, false);
});

test("fast submit rejects a category that is not a Form option before any writes", () => {
  const service = fastService();
  const result = service.post({ ...payload, category: "Mixed Doubles" });
  assert.equal(result.status, "error");
  assert.match(result.message, /category/);
  assert.deepEqual(service.events, []);
});

test("cleanupOrphanUploads trashes only old files that no response links to", () => {
  const service = fastService();
  const used = uploadFor(service, "photo").upload;
  uploadFor(service, "document");
  uploadFor(service, "photo");
  assert.equal(service.post({ ...textPayload, photoUpload: used, document: payload.document }).status, "success");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  service.files.forEach((file) => { file.created = old; });
  uploadFor(service, "document");

  assert.equal(service.run("cleanupOrphanUploads"), 2);
  assert.deepEqual(service.files.map((file) => file.trashed), [false, true, true, false, false]);
});

test("setup prepares the folder, token secret, entry map and a single cleanup trigger", () => {
  const service = createService();
  service.run("setup");
  service.run("setup");
  assert.ok(service.properties.uploadTokenSecret);
  assert.ok(service.properties.registrationIndexReady);
  assert.equal(JSON.parse(service.properties.formMap).fastSubmit, true);
  assert.equal(service.triggers.length, 1);
  assert.equal(service.triggers[0].getHandlerFunction(), "cleanupOrphanUploads");
});

test("an unknown /formResponse outcome is confirmed against the Form before resubmitting", () => {
  // Google saved the response but the reply was lost: no second response.
  for (const options of [{ formResponseStatus: 500, formResponseSaves: true }, { fetchThrows: true, formResponseSaves: true }]) {
    const service = fastService(options);
    const result = service.post(payload);
    assert.equal(result.status, "success");
    assert.equal(result.route, "formResponse (confirmed)");
    assert.equal(service.responses.length, 1);
    assert.ok(!service.events.includes("submit"));
    assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player"]);
  }

  // Nothing was saved: FormApp saves it exactly once.
  for (const options of [{ formResponseStatus: 503 }, { fetchThrows: true, formResponseSaves: false }]) {
    const service = fastService(options);
    const result = service.post(payload);
    assert.equal(result.status, "success");
    assert.equal(result.route, "formApp");
    assert.equal(service.responses.length, 1);
    assert.deepEqual(service.events.filter((event) => event === "scan" || event === "submit"), ["scan", "submit"]);
  }
});

test("discard trashes a replaced upload but never one a registration links to", () => {
  const service = createService({ indexReady: true });
  const replaced = uploadFor(service, "photo").upload;
  const finalPhoto = uploadFor(service, "photo").upload;
  const documentUpload = uploadFor(service, "document").upload;

  assert.deepEqual(service.post({ action: "discard", kind: "photo", upload: replaced }), { status: "success", trashed: true });
  assert.equal(service.files[0].trashed, true);

  assert.equal(service.post({ ...textPayload, photoUpload: finalPhoto, documentUpload }).status, "success");
  assert.equal(service.properties["claimed:" + service.files[1].id], "1");
  assert.equal(service.properties["claimed:" + service.files[2].id], "1");

  // A replayed discard for a registered file is ignored.
  assert.deepEqual(service.post({ action: "discard", kind: "photo", upload: finalPhoto }), { status: "success", trashed: false });
  assert.deepEqual(service.post({ action: "discard", kind: "document", upload: documentUpload }), { status: "success", trashed: false });
  assert.equal(service.files[1].trashed, false);
  assert.equal(service.files[2].trashed, false);
});

test("discard rejects forged, mismatched and unknown tokens", () => {
  const service = createService();
  const photo = uploadFor(service, "photo").upload;
  const forged = { payload: JSON.stringify({ ...JSON.parse(photo.payload), id: "someone-elses-file" }), sig: photo.sig };
  for (const data of [
    { action: "discard", kind: "photo", upload: forged },
    { action: "discard", kind: "document", upload: photo },
    { action: "discard", kind: "resume", upload: photo },
    { action: "discard", kind: "photo" }
  ]) {
    assert.equal(service.post(data).status, "error");
  }
  assert.equal(service.files[0].trashed, false);
});

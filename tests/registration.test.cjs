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


function createService({
  lockAvailable = true, failSubmit = false, failRecord = false,
  indexReady = false, existing = [], onLock = null, missingTitles = [],
  collectsEmail = false, formResponseStatus = 200, formResponseSaves = null, fetchThrows = false,
  extraItems = []
} = {}) {
  const responses = [];
  const properties = indexReady ? { registrationIndexReady: "2026-10-06T00:00:00.000Z" } : {};
  const cache = {};
  const fetches = [];
  const sessionRequests = [];
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
  const items = titles.map((title, index) => ({ title, index })).concat(extraItems.map((extra, i) => ({ ...extra, index: 100 + i })))
    .map(({ title, index, type: extraType, required }) => {
    const type = extraType || (title === "Date of Birth" ? types.DATE
      : title === "Category" || title === "T-Shirt Size" ? types.LIST : types.TEXT);
    const choices = title === "Category" ? CATEGORIES : title === "T-Shirt Size" ? TSHIRT_SIZES : [];
    const item = {
      entryId: String(1000 + index),
      getTitle: () => title,
      getType: () => type,
      includesYear: () => true,
      isRequired: () => (required === undefined ? title !== "Comments" : required),
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
        getTimestamp: () => new Date(),
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
      return makeFile(blob.name, blob.mimeType, blob.bytes.length);
    }
  };
  function makeFile(name, mimeType, size, parent = folder) {
    const id = "1DriveFileId" + String(files.length).padStart(12, "0");
    const file = {
      id, name, mimeType, size,
      created: new Date(),
      trashed: false,
      getId: () => id,
      getName: () => file.name,
      getMimeType: () => file.mimeType,
      getSize: () => file.size,
      isTrashed: () => file.trashed,
      getParents: () => {
        let done = false;
        return { hasNext: () => !done, next: () => { done = true; return parent; } };
      },
      getUrl: () => "https://drive.google.com/file/d/" + id + "/view?usp=drivesdk",
      getDateCreated: () => file.created,
      setName: (value) => { events.push("rename"); file.name = value; },
      setTrashed: (value) => { file.trashed = value; }
    };
    files.push(file);
    return file;
  }
  // Simulates Google's /formResponse endpoint: a 200 stores the response.
  function formResponseFetch(url, options) {
    const driveFile = /\/drive\/v3\/files\/([-\w]+)$/.exec(url);
    if (driveFile && options.method === "delete") {
      events.push("delete");
      const file = files.find((candidate) => candidate.id === driveFile[1]);
      if (file) file.trashed = file.deleted = true;
      return { getResponseCode: () => (file ? 204 : 404) };
    }
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
      getFileById: (id) => {
        const file = files.find((candidate) => candidate.id === id);
        if (!file) throw new Error("No item with the given ID could be found.");
        return file;
      },
      getRootFolder: () => ({
        getFoldersByName: () => {
          folderSearches++;
          return { hasNext: () => true, next: () => folder };
        }
      })
    },
    UrlFetchApp: {
      fetch: formResponseFetch,
      // Drive resumable-session creation; each session is one upload URL.
      fetchAll: (requests) => requests.map((request) => {
        events.push("session");
        sessionRequests.push(request);
        return {
          getResponseCode: () => 200,
          getHeaders: () => ({
            Location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u" + sessionRequests.length
          })
        };
      })
    },
    ScriptApp: {
      getOAuthToken: () => "owner-token",
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (trigger) => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: (handler) => ({
        timeBased: () => ({
          everyHours: (hours) => ({
            create: () => triggers.push({ getHandlerFunction: () => handler, hours })
          })
        }),
        forForm: (formId) => ({
          onFormSubmit: () => ({
            create: () => triggers.push({ getHandlerFunction: () => handler, formId })
          })
        })
      })
    },
    Utilities: {
      formatDate: (date, timeZone, format) => (format === "yyyy-MM-dd HH:mm:ss" && timeZone === "Asia/Kolkata"
        ? "2026-10-06 12:00:00" : "20261006-120000"),
      base64Decode: (value) => Buffer.from(value, "base64"),
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
    sessionRequests,
    rebuildIndex: () => context.rebuildRegistrationIndex(),
    run: (name) => context[name](),
    // What the browser's PUT to a Drive upload URL creates.
    directUpload: (kind, mimeType = kind === "photo" ? "image/jpeg" : "application/pdf", size = 1000) =>
      makeFile("pending_20261006-120000_" + (kind === "photo" ? "display-photo" : "document") + "_abcd1234", mimeType, size),
    otherFolderFile: () => makeFile("private.pdf", "application/pdf", 10, { getId: () => "other-folder" }),
    fireSubmitTrigger: (response) => context.onRegistrationSubmit({ response })
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

/* ---------- Direct uploads and fast /formResponse submit ---------- */

const { photo: _photo, document: _document, ...textPayload } = payload;
const ORIGIN = "https://sihimogepremierleague.github.io";

function fastService(options) {
  const service = createService({ indexReady: true, ...options });
  assert.equal(service.get({ warm: "1" }).status, "ok");
  service.events.length = 0;
  return service;
}

function directFiles(service) {
  return {
    photoFileId: service.directUpload("photo").id,
    documentFileId: service.directUpload("document").id
  };
}

test("prepare returns the Form entry map and Drive upload URLs for the website origin", () => {
  const service = createService({ indexReady: true });
  const body = service.get({ prepare: "1", origin: ORIGIN });
  assert.equal(body.status, "ok");
  assert.equal(typeof body.serverTime, "number");
  assert.equal(body.formMap.url, "https://docs.google.com/forms/d/e/pub-id/formResponse");
  assert.deepEqual(body.formMap.entries["Date of Birth"], { type: "DATE", required: true, id: "1002" });
  assert.equal(body.sessions.photo.length, 2);
  assert.equal(body.sessions.document.length, 2);
  assert.match(body.sessions.photo[0], /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable&upload_id=/);

  const request = service.sessionRequests[0];
  assert.equal(request.headers.Origin, ORIGIN, "sessions accept the website's CORS uploads");
  assert.equal(request.headers.Authorization, "Bearer owner-token");
  const metadata = JSON.parse(request.payload);
  assert.deepEqual(metadata.parents, ["folder-1"]);
  assert.match(metadata.name, /^pending_20261006-120000_display-photo_[0-9a-f]{8}$/);

  const refill = service.get({ prepare: "1", origin: ORIGIN, kinds: "document", count: "9" });
  assert.equal(refill.sessions.document.length, 3, "session count is capped");
  assert.equal(refill.sessions.photo, undefined);

  const noOrigin = service.get({ prepare: "1", origin: "javascript:alert(1)" });
  assert.equal(noOrigin.sessions, undefined);
  assert.ok(noOrigin.formMap);
});

test("background duplicate pre-check confirms index hits against the Form", () => {
  const service = createService({ indexReady: true, existing: [["Test Player", "0123456789"]] });
  service.properties["reg:0123456789"] = JSON.stringify(["test player"]);
  service.properties["reg:1111111111"] = JSON.stringify(["deleted player"]);
  assert.equal(service.get({ check: "1", name: " test  PLAYER ", mobile: "0123456789" }).duplicate, true);
  assert.equal(service.get({ check: "1", name: "Someone Else", mobile: "0123456789" }).duplicate, false);
  assert.equal(service.get({ check: "1", name: "Deleted Player", mobile: "1111111111" }).duplicate, false);
  assert.equal(service.get({ check: "1", name: "x", mobile: "123" }).status, "error");
});

test("Apps Script registration links directly uploaded files and names them", () => {
  const service = createService({ indexReady: true });
  const ids = directFiles(service);
  const result = service.post({ ...textPayload, ...ids });
  assert.equal(result.status, "success");
  assert.ok(!service.events.includes("upload"));
  assert.equal(answerFor(service, "Display Photo"), "https://drive.google.com/file/d/" + ids.photoFileId + "/view?usp=drivesdk");
  assert.equal(answerFor(service, "Document"), "https://drive.google.com/file/d/" + ids.documentFileId + "/view?usp=drivesdk");
  assert.match(service.files[0].name, /^\d{8}-\d{6}_0123456789_test-player_display-photo\.jpg$/);
  assert.match(service.files[1].name, /^\d{8}-\d{6}_0123456789_test-player_document\.pdf$/);
});

test("file ids outside the upload folder or unknown ids are rejected without saving", () => {
  const service = createService({ indexReady: true });
  const outside = service.otherFolderFile();
  for (const photoFileId of [outside.id, "1DoesNotExist000000000000", "../../etc"]) {
    const result = service.post({ ...textPayload, photoFileId, document: payload.document });
    assert.equal(result.status, "error");
    assert.match(result.message, /photo upload was not found/);
  }
  assert.equal(service.responses.length, 0);
  assert.equal(outside.name, "private.pdf");
});

test("form submit trigger names linked uploads and updates the duplicate index", () => {
  const service = fastService();
  const ids = directFiles(service);
  // A response the website posted straight to /formResponse.
  const response = formResponseFor(ids);
  service.addResponse("Test Player", "0123456789");
  service.fireSubmitTrigger(response);
  assert.match(service.files[0].name, /^\d{8}-\d{6}_0123456789_test-player_display-photo\.jpg$/);
  assert.match(service.files[1].name, /^\d{8}-\d{6}_0123456789_test-player_document\.pdf$/);
  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player"]);

  // Running again (e.g. a duplicate that slipped through) changes nothing.
  service.fireSubmitTrigger(response);
  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player"]);
  assert.equal(service.get({ check: "1", name: "Test Player", mobile: "0123456789" }).duplicate, true);
});

function formResponseFor(ids) {
  const link = (id) => "https://drive.google.com/file/d/" + id + "/view?usp=drivesdk";
  const answers = Object.entries({
    Name: "Test Player", "Mobile Number": "0123456789",
    "Display Photo": link(ids.photoFileId), Document: link(ids.documentFileId)
  }).map(([title, value]) => ({ getItem: () => ({ getTitle: () => title }), getResponse: () => value }));
  return { getItemResponses: () => answers, getTimestamp: () => new Date() };
}

test("warm-up GET builds the Form entry map once; plain GET does not", () => {
  const service = createService();
  service.get({});
  assert.equal(service.properties.formMap, undefined);

  service.get({ warm: "1" });
  const map = JSON.parse(service.properties.formMap);
  assert.equal(map.fastSubmit, true);
  assert.equal(map.url, "https://docs.google.com/forms/d/e/pub-id/formResponse");
  assert.deepEqual(map.entries["Date of Birth"], { type: "DATE", required: true, id: "1002" });
  assert.deepEqual(map.entries.Category.choices, CATEGORIES);

  service.events.length = 0;
  service.get({ warm: "1" });
  assert.deepEqual(service.events, [], "a fresh map is not rebuilt");
});

test("Apps Script fast submit posts one /formResponse request without opening the Form", () => {
  const service = fastService();
  const ids = directFiles(service);
  service.events.length = 0;
  const result = service.post({ ...textPayload, submissionId: "abcdefgh-1234", ...ids });
  assert.equal(result.status, "success");
  assert.equal(result.route, "formResponse");
  assert.deepEqual(service.events.filter((event) => event !== "rename"), ["lock", "fetch", "release"]);
  assert.equal(typeof result.timingsMs.total, "number");

  const { url, options, fields } = service.fetches[0];
  assert.equal(url, "https://docs.google.com/forms/d/e/pub-id/formResponse");
  assert.equal(options.followRedirects, false);
  assert.equal(fields["entry.1000"], "Test Player");
  assert.equal(fields["entry.1002_year"], "1996");
  assert.equal(fields["entry.1002_month"], "10");
  assert.equal(fields["entry.1002_day"], "6");
  assert.equal(fields["entry.1003"], "G/N Doubles");
  assert.equal(fields["entry.1006"], "https://drive.google.com/file/d/" + ids.photoFileId + "/view?usp=drivesdk");
  assert.equal(fields["entry.1009"], "2026-10-06 12:00:00");
  assert.equal(fields["entry.1010"], "30 years, 242 days");
  assert.equal(fields["entry.1005"], undefined, "empty comments are not sent");

  assert.deepEqual(JSON.parse(service.properties["reg:0123456789"]), ["test player"]);
  assert.ok(service.properties["submission:abcdefgh-1234"]);
  assert.match(service.post({ ...textPayload, ...ids }).message, /already exists/);
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
  assert.equal(service.get({ prepare: "1", origin: ORIGIN }).formMap, undefined, "the website falls back too");
});

test("fast submit rejects a category that is not a Form option before any writes", () => {
  const service = fastService();
  const result = service.post({ ...payload, category: "Mixed Doubles" });
  assert.equal(result.status, "error");
  assert.match(result.message, /category/);
  assert.deepEqual(service.events, []);
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

test("discard trashes a replaced pending upload but never a linked or foreign file", () => {
  const service = createService({ indexReady: true });
  const replaced = service.directUpload("photo");
  const ids = directFiles(service);
  const outside = service.otherFolderFile();

  assert.deepEqual(service.post({ action: "discard", fileId: replaced.id }), { status: "success", trashed: true });
  assert.equal(replaced.trashed, true);

  assert.equal(service.post({ ...textPayload, ...ids }).status, "success");
  for (const fileId of [ids.photoFileId, ids.documentFileId]) {
    assert.deepEqual(service.post({ action: "discard", fileId }), { status: "success", trashed: false });
  }
  assert.equal(service.post({ action: "discard", fileId: outside.id }).status, "error");
  assert.equal(service.post({ action: "discard" }).status, "error");
  assert.ok(service.files.slice(1).every((file) => !file.trashed));
});

test("cleanupOrphanUploads trashes old unlinked files and deletes oversized ones at once", () => {
  const service = fastService();
  const ids = directFiles(service);
  service.directUpload("photo");
  assert.equal(service.post({ ...textPayload, ...ids }).status, "success");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  service.files.forEach((file) => { file.created = old; });
  service.directUpload("document");
  service.directUpload("document", "application/pdf", 50 * 1024 * 1024);

  assert.equal(service.run("cleanupOrphanUploads"), 2);
  assert.deepEqual(service.files.map((file) => file.trashed), [false, false, true, false, true]);
  assert.deepEqual(service.files.map((file) => Boolean(file.deleted)), [false, false, false, false, true]);
});

test("setup prepares the folder, entry map and the cleanup and form submit triggers once", () => {
  const service = createService();
  service.run("setup");
  service.run("setup");
  assert.ok(service.properties.registrationIndexReady);
  assert.equal(JSON.parse(service.properties.formMap).fastSubmit, true);
  assert.deepEqual(service.triggers.map((trigger) => trigger.getHandlerFunction()).sort(),
    ["cleanupOrphanUploads", "onRegistrationSubmit"]);
  const diagnostics = service.get({ diagnostics: "1" });
  assert.equal(diagnostics.submitTriggerInstalled, true);
  assert.equal(diagnostics.cleanupTriggerInstalled, true);
});

test("a fallback after a failed direct Form post does not save the player twice", () => {
  const service = createService({ indexReady: true, existing: [["Test Player", "0123456789"]] });
  const ids = directFiles(service);
  const result = service.post({ ...textPayload, ...ids, formResponseAttempted: true });
  assert.equal(result.status, "success");
  assert.equal(result.alreadyRecorded, true);
  assert.equal(service.responses.length, 1);

  const fresh = createService({ indexReady: true });
  const freshIds = directFiles(fresh);
  assert.equal(fresh.post({ ...textPayload, ...freshIds, formResponseAttempted: true }).status, "success");
  assert.equal(fresh.responses.length, 1);
});

test("trashed uploads are not linked, but the submit trigger restores files a response links", () => {
  const service = createService({ indexReady: true });
  const ids = directFiles(service);
  service.files[0].trashed = true;
  const result = service.post({ ...textPayload, ...ids });
  assert.equal(result.status, "error");
  assert.match(result.message, /photo upload was not found/);

  service.fireSubmitTrigger(formResponseFor(ids));
  assert.equal(service.files[0].trashed, false);
  assert.match(service.files[0].name, /_0123456789_test-player_display-photo\.jpg$/);
});

test("a required question the website does not fill in turns fast submit off", () => {
  const required = createService({ extraItems: [{ title: "Emergency Contact", type: "TEXT", required: true }] });
  required.get({ warm: "1" });
  const map = JSON.parse(required.properties.formMap);
  assert.equal(map.fastSubmit, false);
  assert.match(map.reason, /Emergency Contact/);
  assert.equal(required.get({ prepare: "1", origin: ORIGIN }).formMap, undefined);

  for (const extra of [
    { title: "Referral", type: "TEXT", required: false },
    { title: "Rules", type: "SECTION_HEADER" }
  ]) {
    const optional = createService({ extraItems: [extra] });
    optional.get({ warm: "1" });
    assert.equal(JSON.parse(optional.properties.formMap).fastSubmit, true, extra.title);
  }

  const fileUpload = createService({ extraItems: [{ title: "Certificate", type: "FILE_UPLOAD" }] });
  fileUpload.get({ warm: "1" });
  assert.equal(JSON.parse(fileUpload.properties.formMap).fastSubmit, false);
});

test("the map reports Comments as optional and every other answer as required", () => {
  const service = fastService();
  const entries = JSON.parse(service.properties.formMap).entries;
  assert.equal(entries.Comments.required, false);
  assert.ok(Object.entries(entries).every(([title, entry]) => title === "Comments" || entry.required));
});

test("upload URL requests are rate limited and a map-only prepare creates none", () => {
  const service = createService({ indexReady: true });
  assert.equal(service.get({ prepare: "1", origin: ORIGIN, kinds: "" }).sessions, undefined);
  assert.equal(service.sessionRequests.length, 0);

  let granted = 0;
  for (let i = 0; i < 125; i++) {
    if (service.get({ prepare: "1", origin: ORIGIN, kinds: "photo", count: "1" }).sessions) granted++;
  }
  assert.equal(granted, 120);
});

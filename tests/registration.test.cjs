const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");

function createService({
  lockAvailable = true, failSubmit = false, failRecord = false,
  indexReady = false, existing = [], onLock = null
} = {}) {
  const responses = [];
  const properties = indexReady ? { registrationIndexReady: "2026-10-06T00:00:00.000Z" } : {};
  let lockCalls = 0;
  let folderSearches = 0;
  const files = [];
  const events = [];
  const types = { TEXT: "TEXT", PARAGRAPH_TEXT: "PARAGRAPH_TEXT", DATE: "DATE", LIST: "LIST", MULTIPLE_CHOICE: "MULTIPLE_CHOICE" };
  const titles = ["Name", "Age", "Date of Birth", "Category", "Mobile Number", "Comments", "Display Photo", "Document"];
  const items = titles.map((title) => {
    const type = title === "Date of Birth" ? types.DATE : title === "Category" ? types.LIST : types.TEXT;
    const item = {
      getTitle: () => title,
      getType: () => type,
      createResponse: (value) => ({ getItem: () => item, getResponse: () => value })
    };
    item.asTextItem = item.asDateItem = item.asListItem = () => item;
    return item;
  });
  const form = {
    getTitle: () => "SPL Registration",
    isAcceptingResponses: () => true,
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
    isTrashed: () => false,
    createFile: () => {
      events.push("upload");
      const file = {
        trashed: false,
        getUrl: () => "https://drive.google.com/test-file",
        setTrashed: (value) => { file.trashed = value; }
      };
      files.push(file);
      return file;
    }
  };
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
        setProperties: (values) => { Object.assign(properties, values); },
        deleteProperty: (key) => { delete properties[key]; }
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
      getRootFolder: () => ({
        getFoldersByName: () => {
          folderSearches++;
          return { hasNext: () => true, next: () => folder };
        }
      })
    },
    Utilities: {
      formatDate: () => "20261006-120000",
      base64Decode: (value) => Buffer.from(value, "base64"),
      newBlob: (bytes) => bytes
    },
    ContentService: {
      MimeType: { JSON: "JSON" },
      createTextOutput: (text) => ({ setMimeType() {}, text })
    }
  });
  function addResponse(name, mobile) {
    const response = form.createResponse();
    response.withItemResponse(items[0].createResponse(name));
    response.withItemResponse(items[4].createResponse(mobile));
    responses.push(response);
  }
  existing.forEach(([name, mobile]) => addResponse(name, mobile));
  vm.runInContext(source, context);
  const api = {
    files, responses, events, properties, addResponse,
    folderSearches: () => folderSearches,
    post: (data) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text),
    get: (parameter) => JSON.parse(context.doGet({ parameter }).text),
    rebuildIndex: () => context.rebuildRegistrationIndex()
  };
  return api;
}

const payload = {
  name: "Test Player",
  mobile: "0123456789",
  age: "30 years, 0 days",
  dob: "1996-10-06",
  category: "G/N Doubles",
  photo: "data:image/jpeg;base64,dGVzdA==",
  document: "data:application/pdf;base64,dGVzdA=="
};

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

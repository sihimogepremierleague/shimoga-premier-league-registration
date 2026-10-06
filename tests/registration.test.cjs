const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../apps-script/Code.gs"), "utf8");

function createService({ lockAvailable = true, failSubmit = false } = {}) {
  const responses = [];
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
    getItems: (type) => items.filter((item) => !type || item.getType() === type),
    getResponses: () => {
      events.push("check");
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
    console: { error() {}, warn() {} },
    FormApp: { openById: () => form, ItemType: types },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { events.push("lock"); return lockAvailable; },
        releaseLock: () => { events.push("release"); }
      })
    },
    DriveApp: { getRootFolder: () => ({ getFoldersByName: () => ({ hasNext: () => true, next: () => folder }) }) },
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
  vm.runInContext(source, context);
  return {
    files, responses, events,
    post: (data) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text)
  };
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
  assert.deepEqual(service.events, ["lock", "check", "upload", "upload", "submit", "release", "lock", "check", "release"]);
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
  assert.deepEqual(service.events, ["lock"]);
  assert.equal(service.files.length, 0);
});

test("failed submission cleans up files and releases lock", () => {
  const service = createService({ failSubmit: true });
  assert.equal(service.post(payload).status, "error");
  assert.equal(service.responses.length, 0);
  assert.equal(service.files.length, 2);
  assert.ok(service.files.every((file) => file.trashed));
  assert.equal(service.events.at(-1), "release");
});

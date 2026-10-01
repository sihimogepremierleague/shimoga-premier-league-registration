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
 *    Display Photo
 *    Document
 *
 * 2. Replace GOOGLE_FORM_ID below.
 * 3. Deploy as a Web app:
 *    Execute as: Me
 *    Who has access: Anyone
 * 4. Copy the Web app URL into index.html.
 *
 * The script submits into the Google Form itself, so the normal
 * Google Form response destination (including Google Sheets) continues
 * to work.
 */

const GOOGLE_FORM_ID = "1FAIpQLSfhmixICSDxKorc7QeOEZvjKWwSAv0HBYTIywQ2hQYj-VcXCw";
const SUCCESS_URL = "PASTE_YOUR_GITHUB_PAGES_URL_HERE";
const ERROR_URL = SUCCESS_URL;

function doPost(e) {
  try {
    const data = parseRequestPayload(e);
    const form = FormApp.openById(GOOGLE_FORM_ID);
    const response = form.createResponse();

    addText(response, form, "Name", data.name);
    addText(response, form, "Age", data.age);
    addDate(response, form, "Date of Birth", data.dob);
    addChoice(response, form, "Category", data.category);
    addText(response, form, "Mobile Number", data.mobile);
    addText(response, form, "Comments", data.comment);
    addFile(response, form, "Display Photo", data.photo);
    addFile(response, form, "Document", data.document);

    response.submit();
    return ContentService.createTextOutput(JSON.stringify({ status: "success" })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    console.error(err);
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err && err.message ? err.message : String(err)
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function parseRequestPayload(e) {
  if (e && e.postData && e.postData.contents) {
    const type = String(e.postData.type || "").toLowerCase();
    if (type.indexOf("application/json") !== -1) {
      try {
        return JSON.parse(e.postData.contents);
      } catch (err) {
        return {};
      }
    }
  }

  return e && e.parameter ? e.parameter : {};
}

function addText(response, form, title, value) {
  if (!value) return;
  const item = findItem(form, title, FormApp.ItemType.TEXT);
  if (item) response.withItemResponse(item.asTextItem().createResponse(String(value)));
}

function addDate(response, form, title, value) {
  if (!value) return;
  const item = findItem(form, title, FormApp.ItemType.DATE);
  if (item) {
    const parts = String(value).split("-");
    if (parts.length === 3) {
      const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      response.withItemResponse(item.asDateItem().createResponse(date));
    }
  }
}

function addChoice(response, form, title, value) {
  if (!value) return;
  const item = findItem(form, title, FormApp.ItemType.MULTIPLE_CHOICE) ||
               findItem(form, title, FormApp.ItemType.LIST);
  if (!item) return;

  if (item.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
    response.withItemResponse(item.asMultipleChoiceItem().createResponse(String(value)));
  } else {
    response.withItemResponse(item.asListItem().createResponse(String(value)));
  }
}

function addFile(response, form, title, value) {
  if (!value) return;

  const item = findItem(form, title, FormApp.ItemType.FILE_UPLOAD);
  if (!item) return;

  let blob = null;
  if (typeof value === "string" && value.indexOf("data:") === 0) {
    const match = value.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1];
      const byteArray = Utilities.base64Decode(match[2]);
      const extension = getFileExtensionFromMime(mimeType);
      const fileName = (title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "upload") + extension;
      blob = Utilities.newBlob(byteArray, mimeType, fileName);
    }
  }

  if (blob) {
    response.withItemResponse(item.asFileUploadItem().createResponse(blob));
  }
}

function getFileExtensionFromMime(mimeType) {
  const extensions = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
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

function redirectPage(url) {
  const safeUrl = String(url).replace(/"/g, "&quot;");
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="0;url=' + safeUrl + '">' +
    '</head><body>' +
    '<script>window.top.location.href=' + JSON.stringify(url) + ';</script>' +
    '</body></html>'
  );
}

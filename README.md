# Shimoga Premier League — Registration Website

A lightweight, mobile-friendly registration page using:

**Website → Google Apps Script → Google Form → Google Sheets**

The page is intentionally designed as a tournament registration page, not as an official government/authority website.

## Included

- Responsive registration page
- Supplied SPL logo
- Custom badminton/Shivamogga background
- Name, age, DOB, category, mobile, comments, display photo and document fields
- Client-side validation
- Success message
- Failure message
- Google Form submission through Apps Script
- No paid server required

## 1. Create the Google Form

Create a Google Form and add questions with these exact titles:

1. `Name` — Short answer
2. `Age` — Short answer
3. `Date of Birth` — Date
4. `Category` — Dropdown OR Multiple choice
5. `Mobile Number` — Short answer
6. `Comments` — Long answer
7. `Display Photo` — Short answer (stores a Google Drive link)
8. `Document` — Short answer (stores a Google Drive link)

> Do **not** use the "File upload" question type. Apps Script cannot submit
> files into File upload questions. The script saves the uploaded photo and ID
> document to a private Google Drive folder and writes each file's Drive link
> into these two questions instead.

For Category, add:
- G/N Doubles
- 30+ Men's Doubles
- 40+ Men's Doubles
- 50+ & 35+ Jumble Doubles

Link the Google Form to a Google Sheet if you want responses in a spreadsheet.

## 2. Get the Google Form ID

If the form URL is:

https://docs.google.com/forms/d/FORM_ID/edit

then `FORM_ID` is the value between `/d/` and `/edit`.

> Use the **edit** ID shown above. The public URL
> `https://docs.google.com/forms/d/e/1FAIpQLS.../viewform` contains a different
> ID that `FormApp.openById()` cannot open.

Put that value into `apps-script/Code.gs`:

const GOOGLE_FORM_ID = "YOUR_FORM_ID";

## 3. Deploy Apps Script

Go to https://script.google.com/

Create a new project and paste the contents of `apps-script/Code.gs`.

Deploy → New deployment → Web app

Use:
- Execute as: Me
- Who has access: Anyone

Authorize the script when Google asks.

Then, in the Apps Script editor, select the `setupUploadFolder` function in the
toolbar and click **Run**. This grants Google Drive access and creates the
`SPL Registration Uploads` folder in your My Drive. Uploads are owned by you and
stay private. To use an existing folder instead, set `UPLOAD_FOLDER_ID` in
`Code.gs`. Run it again whenever Google asks for new permissions after a code
change, otherwise the web app returns an authorization error.

Copy the Web app URL.

> **Redeploying after any code change:** editing `Code.gs` does *not* update the
> live `/exec` URL. You must go to **Deploy → Manage deployments → Edit (pencil)
> → Version: New version → Deploy**. Creating only a new "test deployment" or
> saving the file is not enough — the old code keeps serving until you publish a
> new version.

## 4. Configure the website

Open `index.html` and replace:

PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE

with the Apps Script Web app URL.

Then set the Google Form edit ID in `apps-script/Code.gs`:

const GOOGLE_FORM_ID = "YOUR_FORM_EDIT_ID";

## 5. Verify the deployment

Open the Web app `/exec` URL directly in a browser. `doGet` returns a JSON
health check, for example:

```json
{
  "status": "ok",
  "deployedVersion": "2026-10-06-drive-uploads",
  "formTitle": "SPL Registration",
  "items": [{ "title": "Name", "type": "TEXT" }],
  "missingTitles": [],
  "wrongTypeTitles": [],
  "acceptsResponses": true
}
```

Check that:

- `deployedVersion` matches `DEPLOY_MARKER` in your local `Code.gs`. If it does
  not, the new version was never deployed.
- `missingTitles` is empty. Anything listed there is a Google Form question
  whose title does not exactly match what `Code.gs` expects.
- `wrongTypeTitles` is empty. Anything listed there (normally `Display Photo`
  or `Document`) is still a File upload question and must be changed to Short
  answer.
- `status` is `ok`. A `status` of `error` usually means `GOOGLE_FORM_ID` is the
  published `1FAIpQLS...` id instead of the edit id.

If you get a raw HTML error page instead of JSON, the script is throwing before
it can respond. That page has no CORS header, so the browser reports it on the
website as `TypeError: Failed to fetch`.

## 6. Test before publishing

Open the website and submit a test registration.

Expected flow:

1. User fills the custom website form.
2. User clicks Submit Registration.
3. Apps Script receives the data.
4. Apps Script creates a response in the Google Form.
5. Google Form records the response.
6. User returns to the website and sees:
   "Registration submitted successfully. Thank you!"

If anything fails, the user is returned with a generic failure message.

## Troubleshooting CORS errors

Apps Script web apps have two hard limits that cause browser CORS failures:

1. They do **not** answer preflight `OPTIONS` requests. The page therefore posts
   JSON with `Content-Type: text/plain;charset=utf-8`, which keeps the request a
   CORS "simple request" so no preflight is sent. Do not change this header back
   to `application/json`.
2. They cannot set custom response headers. `ContentService.TextOutput` has no
   `setHeader()` method — calling it throws, and Apps Script then returns an HTML
   error page without `Access-Control-Allow-Origin`, which the browser reports as
   a CORS error. Never add `Access-Control-*` headers in `Code.gs`.

A `302` response from `/exec` in the browser Network tab is expected, not an
error. Apps Script runs `doPost`/`doGet`, then redirects to
`script.googleusercontent.com/macros/echo?...` to deliver the output. Both hops
send `Access-Control-Allow-Origin: *`, and `fetch` follows the redirect
automatically, so the final response is a `200` with the JSON body. The redirect
cannot be disabled; do not set `redirect: "manual"` on the `fetch` call.

Other checks when the browser still reports CORS:

- Deployment access must be **Anyone**. With "Anyone with Google account" the
  request is redirected to a login page that has no CORS header.
- After editing `Code.gs`, use **Deploy → Manage deployments → Edit → New
  version**. The `/exec` URL keeps serving the old code until you do.
- Run `doPost` once in the Apps Script editor and accept the authorization
  prompt. An unauthorized script returns an error page instead of JSON.

## 7. Free hosting

GitHub Pages can host these static files.

Create a public GitHub repository, upload:

- index.html
- styles.css
- assets/spl-logo.jpg
- assets/badminton-background.jpg

Then enable:

Settings → Pages → Deploy from branch → main → / (root)

GitHub will provide a free `github.io` address.

## Extending the form later

To add another field:

1. Add the question to Google Form.
2. Add the corresponding HTML field in `index.html`.
3. Add one matching function call in `Code.gs`.

The Apps Script intentionally finds Google Form questions by their titles rather than hard-coding Google Form entry IDs.

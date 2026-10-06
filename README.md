# Shimoga Premier League — Registration Website

A lightweight, mobile-friendly registration page using:

**Website → Google Apps Script → Google Form → Google Sheets**

The page is intentionally designed as a tournament registration page, not as an official government/authority website.

## Included

- Responsive registration page
- Supplied SPL logo
- Custom badminton/Shivamogga background
- Name, age, DOB, category, mobile, T-shirt size, comments, display photo and document fields
- Age is auto-calculated from Date of Birth and shown read-only as
  `X years, Y days`; players must be at least 14 years old (the date picker does
  not offer later dates) and DOB cannot be more than 70 years ago
- Display photo and document are limited to 5 MB each (checked in the browser
  and again in Apps Script). Large document images (400 KB or more) are resized
  in the browser to at most 2000 px and re-encoded as JPEG before upload; PDFs
  are sent unchanged
- Display photo can be chosen from files or taken with the camera (**Take Photo**).
  Phones and tablets open the native camera; desktops show a live camera preview
  with a face guide, shutter and front/back switch, and fall back to the file
  picker when no camera API is available. Camera shots go through the same cropper,
  so full-resolution phone photos (up to 25 MB) are accepted before cropping
- T-shirt size (S, M, L, XL, XXL) is mandatory and validated in the browser and Apps Script
- Mobile-friendly photo cropper: drag to move, pinch / slider to zoom, rotate;
  the cropped photo is saved as a square JPEG of at most 800×800 px
- Client-side validation
- Name is limited to 50 characters and Comments to 250 characters (with a live
  counter), enforced in the browser and Apps Script
- Auction Date (15 Nov 2026) and League Date (6 Dec 2026) shown at the top of the form
- Mobile numbers must contain exactly 10 digits, validated in the browser and Apps Script
- A spinner and preparation/submission status remain visible until registration succeeds or fails;
  repeat submissions from the same page are blocked while a request is running
- Duplicate registrations are rejected when both mobile number and name match an existing
  Google Form response (names ignore case and repeated/leading/trailing whitespace).
  The check uses a name/mobile index kept in Script Properties, so it does not slow down as
  registrations grow. Uploads run outside the script lock; only the final duplicate check and
  the Form submit are serialized, so concurrent registrations do not queue behind each other.
  The same mobile number with a different name, or the same name with a different mobile, is allowed.
  This applies to submissions through the web app; direct Google Form submissions bypass the check.
- Photo selection area is 10% smaller, with scrollable crop controls on short screens
- Success page (`success.html`) in the same theme: after a confirmed registration the
  browser is taken to a confirmation screen showing the player's photo, name, category,
  masked mobile number and submission time, plus next steps (verification, auction, league)
  and organizer contacts. The summary is passed via `sessionStorage` (nothing extra is sent
  to the server); opening the page directly shows a generic confirmation instead
- Failure message
- Google Form submission through Apps Script
- No paid server required

## 1. Create the Google Form

Create a Google Form and add questions with these exact titles:

1. `Name` — Short answer
2. `Age` — Short answer (receives text such as `34 years, 120 days`, so do not add number validation)
3. `Date of Birth` — Date
4. `Category` — Dropdown OR Multiple choice
5. `Mobile Number` — Short answer
6. `T-Shirt Size` — Dropdown OR Multiple choice with exactly these options: `S`, `M`, `L`, `XL`, `XXL`
7. `Comments` — Long answer
8. `Display Photo` — Short answer (stores a Google Drive link)
9. `Document` — Short answer (stores a Google Drive link)

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

Then open ⚙️ **Project Settings**, tick **Show "appsscript.json" manifest file
in editor**, and replace the contents of `appsscript.json` with
`apps-script/appsscript.json` from this repository. It declares the two
permissions the script needs: Google Forms (to submit responses) and Google
Drive (to save uploads). If the manifest lists `oauthScopes` without Drive,
every submission fails with "You do not have permission to call DriveApp...".

Deploy → New deployment → Web app

Use:
- Execute as: Me
- Who has access: Anyone

Authorize the script when Google asks.

Then, in the Apps Script editor, select the `setupUploadFolder` function in the
toolbar and click **Run**. This grants Google Drive access and creates the
`SPL Registration Uploads` folder in your My Drive. Uploads are owned by you and
stay private. To use an existing folder instead, set `UPLOAD_FOLDER_ID` in
`Code.gs`. Run it again whenever Google asks for new permissions after a code or manifest
change, then deploy a **new version**. The manifest is saved with each deployed
version, so a permission change only takes effect after redeploying.

Finally, select `rebuildRegistrationIndex` and click **Run**. This builds the
duplicate-check index from the existing Form responses. If you skip it, the
first registration after deployment builds the index instead and is slower.
Run it again after deleting or editing responses in the Google Form.

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

Open the Web app `/exec` URL directly in a browser. It returns a fast liveness
check that does not touch the Form or Drive:

```json
{ "status": "ok", "deployedVersion": "2026-10-06-5mb-uploads" }
```

For the full configuration check, open `/exec?diagnostics=1`, for example:

```json
{
  "status": "ok",
  "deployedVersion": "2026-10-06-5mb-uploads",
  "timingsMs": { "openForm": 400, "readItems": 300, "readResponses": 900, "duplicateScan": 1200, "checkDrive": 500, "total": 3300 },
  "formTitle": "SPL Registration",
  "items": [{ "title": "Name", "type": "TEXT" }],
  "missingTitles": [],
  "wrongTypeTitles": [],
  "acceptsResponses": true,
  "uploadFolderExists": true,
  "driveAuthorized": true,
  "responseCount": 12,
  "recordedSubmissionIds": 12,
  "registrationIndexReady": true,
  "indexedMobileNumbers": 12
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
- `driveAuthorized` is `true`. If it is `false`, submissions fail with
  "You do not have permission to call DriveApp...". Run `setupUploadFolder` in
  the Apps Script editor and accept the Drive permission prompt.
- `status` is `ok`. A `status` of `error` usually means `GOOGLE_FORM_ID` is the
  published `1FAIpQLS...` id instead of the edit id.

`timingsMs` shows where execution time goes. `duplicateScan` grows with the
number of Form responses, but registrations only run that scan to confirm a
likely duplicate; new players are checked against the index. Check that
`registrationIndexReady` is `true` (run `rebuildRegistrationIndex` if it is not).
Each submission id and each indexed mobile number uses one script property
(about 60 bytes of the 500 KB property quota, i.e. several thousand registrations).

If you get a raw HTML error page instead of JSON, the script is throwing before
it can respond. That page has no CORS header, so the browser reports it on the
website as `TypeError: Failed to fetch`.

## 6. Test before publishing

Run the local backend regression tests with Node.js (no packages required):

```sh
node --test tests/registration.test.cjs
```

Open the website and submit a test registration.

Expected flow:

1. User fills the custom website form.
2. User clicks Submit Registration.
3. Apps Script receives the data.
4. Apps Script creates a response in the Google Form.
5. Google Form records the response.
6. User is taken to the success page (`success.html`) with a
   "You're registered!" confirmation and a summary of their registration.

Also verify that a 9-digit number or a number containing non-digits is rejected,
and that resubmitting the same name/mobile pair shows a duplicate error without
saving more files or another response. Check the photo dialog on a short phone
screen: scroll within the dialog if needed to reach Cancel and Use this photo.
Deploy a **new Apps Script version** for mobile validation and duplicate protection
to take effect; publishing the static website alone does not update the backend.

If anything fails, the user is returned with a generic failure message.

## Troubleshooting "Sorry, unable to open the file at this time" (404)

Apps Script runs `/exec`, then redirects the browser to
`script.googleusercontent.com/macros/echo?...` to fetch the result. Google's
echo URL intermittently answers with a 404 "Sorry, unable to open the file at
this time" page, or redirects back to `/exec` (which then runs `doGet` and
redirects to another echo URL that 404s). This happens **after** the script has
finished, so a registration can be saved even though the browser never sees
the success response. It is more frequent when an execution is slow (roughly
30 s or more). It is a long-standing Google issue, not a deployment mistake.

The website handles it:

1. Each submission carries a random `submissionId`. After saving, the script
   records it in Script Properties.
2. If the response is lost (404, non-JSON, a redirect to the health check, or a
   network error), the page asks `/exec?submissionId=<id>` whether it was saved.
3. If it was not saved, the page resubmits with the same id (up to 3 attempts).
   A resubmission of an already-saved id returns success without creating a
   second response or uploading files again.

To keep executions short (and so make these lost responses rare):

- the plain `/exec` health check does not open the Form or Drive;
- the duplicate check reads a Script Properties index instead of every Form response;
- the upload folder id is cached instead of searched for on every request;
- uploads happen outside the script lock, which is held only for the final check and submit;
- the page warms up the script with a liveness `GET` while the user fills in the form;
- a "busy" reply is retried straight away without the status check.

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

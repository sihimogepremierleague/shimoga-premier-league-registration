# Shimoga Premier League — Registration Website

A lightweight, mobile-friendly registration page using:

**Website → Google Apps Script → Google Form → Google Sheets**

The page is intentionally designed as a tournament registration page, not as an official government/authority website.

## Included

- Responsive registration page
- Supplied SPL logo
- Custom badminton/Shivamogga background
- Name, DOB, category, mobile, T-shirt size, comments, display photo and document fields
- Age is auto-calculated from Date of Birth as `X years, Y days` and sent to the
  Google Form, but is not shown on the page; players must be at least 14 years old (the date picker does
  not offer later dates, and opens on the date exactly 14 years ago instead of
  today) and DOB cannot be more than 70 years ago
- Once a DOB is entered, the page shows the categories the player is eligible for, based on
  their age on **5 Jun 2027** (the league is on 6 Dec 2026; this gives every age category a
  6-month relaxation): G/N Doubles — any age; 30+ Men's Doubles — 30+; 40+ Men's Doubles — 40+;
  50+ & 35+ Jumble Doubles — 35+. This is information only; the player still picks the category
- Apps Script also records `Created Date` (submission time in IST, `yyyy-MM-dd HH:mm:ss`) and
  `Player Tournament Age` (age on 5 Jun 2027 as `X years, Y days`, calculated from DOB on the server)
- Display photo and document are limited to 5 MB each (checked in the browser
  and again in Apps Script). Large document images (400 KB or more) are resized
  in the browser to at most 2000 px and re-encoded as JPEG before upload; PDFs
  are sent unchanged
- Fast registration (typically 3–5 s after Submit instead of 12–15 s): the photo and
  Aadhaar upload to Drive in the background while the player fills in the form,
  and the response is saved with one request to the Form's `/formResponse`
  address. See [Troubleshooting](#troubleshooting-sorry-unable-to-open-the-file-at-this-time-404)
  and the expected flow in section 6
- Tapping **Add Photo** (or the empty photo box) opens a sheet offering
  **Take Photo** or **Choose from Gallery**, the same on every device.
  For Take Photo, phones and tablets open the native camera; desktops show a live camera preview
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
10. `Created Date` — Short answer (receives the IST submission time such as `2026-10-08 21:41:38`)
11. `Player Tournament Age` — Short answer (receives text such as `34 years, 120 days`; age on 5 Jun 2027)

> `Created Date` and `Player Tournament Age` are filled in by Apps Script. Add them
> to the form **before** deploying the updated script, otherwise registrations
> fail with "Google Form is missing these question titles".

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
`apps-script/appsscript.json` from this repository. It declares the permissions
the script needs: Google Forms (to read the form), Google Drive (to save uploads),
external requests (for the fast submit to the Form's `/formResponse` address)
and triggers (for the scheduled cleanup of unused uploads). If the manifest lists
`oauthScopes` without Drive, every submission fails with "You do not have
permission to call DriveApp...".

Deploy → New deployment → Web app

Use:
- Execute as: Me
- Who has access: Anyone

Authorize the script when Google asks.

Then, in the Apps Script editor, select the `setup` function in the toolbar and
click **Run**, and accept the permission prompts. It does all one-time setup so
no player waits for it:

- creates the `SPL Registration Uploads` folder in your My Drive (uploads are
  owned by you and stay private; set `UPLOAD_FOLDER_ID` in `Code.gs` to use an
  existing folder instead);
- creates the secret used to sign background-upload tokens;
- builds the duplicate-check index from existing Form responses if it does not
  exist yet;
- builds the Form entry map used for fast submission (`refreshFormMap`);
- schedules `cleanupOrphanUploads` to run every 6 hours.

Run `setup` again whenever Google asks for new permissions after a code or
manifest change, then deploy a **new version**. The manifest is saved with each
deployed version, so a permission change only takes effect after redeploying.

Run `rebuildRegistrationIndex` after deleting or editing responses in the
Google Form, and `refreshFormMap` after changing Form questions (the website also
refreshes the map in the background every 10 minutes).

> **Fast submission needs a public form.** The Google Form must not collect email
> addresses or require sign-in. Otherwise the script falls back to the slower
> FormApp path, and `/exec?diagnostics=1` shows the reason under `fastSubmit`.

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
{ "status": "ok", "deployedVersion": "2026-10-08-fast-submit" }
```

For the full configuration check, open `/exec?diagnostics=1`, for example:

```json
{
  "status": "ok",
  "deployedVersion": "2026-10-08-fast-submit",
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
  "indexedMobileNumbers": 12,
  "uploadSecretReady": true,
  "fastSubmit": { "enabled": true, "reason": "", "mapAgeMinutes": 3 }
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
- `fastSubmit.enabled` is `true`. If it is `false`, `reason` says why (for
  example the form collects email addresses); run `refreshFormMap` after fixing it.
- `uploadSecretReady` is `true` (run `setup` if it is not). Without it,
  background uploads cannot be linked and the website falls back to uploading
  files at Submit.

Each successful registration also returns `route` (`formResponse` or `formApp`)
and `timingsMs` (per-step server time), visible in the browser's Network tab and
logged in **Executions**, so you can see where the time goes.

`timingsMs` shows where execution time goes. `duplicateScan` grows with the
number of Form responses, but registrations only run that scan to confirm a
likely duplicate; new players are checked against the index. Check that
`registrationIndexReady` is `true` (run `rebuildRegistrationIndex` if it is not).
Each submission id, each indexed mobile number and each claimed upload uses one
script property (about 40–60 bytes each, roughly 200 bytes per registration, so
the 500 KB property quota holds about 2,000 registrations).

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

1. User fills the custom website form. As soon as the photo / Aadhaar are chosen
   (and name and mobile are filled in), the page uploads them to Drive in the
   background; Apps Script returns a signed token for each file.
2. User clicks Submit Registration. Only a small text record with the two tokens
   is sent (if a background upload failed, that file is sent inline instead).
3. Apps Script checks for duplicates and posts the answers to the Form's
   `/formResponse` address in one request. If Google rejects it, FormApp saves it
   instead; if the outcome is unknown (timeout / server error), the script first
   checks the Form so the player is never saved twice.
4. Google Form records the response.
5. User is taken to the success page (`success.html`) with a
   "You're registered!" confirmation and a summary of their registration.

What happens to files in unusual cases:

- **A background upload fails** (network drop, Apps Script error): the page
  retries once. If it still fails, nothing is shown to the player; at Submit
  that file is sent inline with the registration (the original, slower path).
  If the file itself is invalid (wrong type, over 5 MB), Submit reports the error.
- **Submit is pressed while an upload is still running**: the page waits for it
  ("Finishing your photo and document upload…") and then submits.
- **An upload token is older than 20 hours** (page left open overnight): the
  script answers `upload_invalid` and the page resends both files inline.
- **The player replaces or removes a photo or Aadhaar**: the page sends a
  `discard` request and the old file is trashed straight away (if its upload is
  still running, as soon as it finishes). A file linked by a submitted
  registration is recorded as `claimed:<fileId>` in Script Properties and is
  never discarded. Photo uploads wait for a 1.2 s pause, so adjusting the crop
  several times uploads only the final photo.
- **Anything missed** (tab closed, lost discard request, player never submits):
  `cleanupOrphanUploads` moves files that no response links to into the Drive
  trash after 24 hours (they can be restored from the trash for 30 days). Files
  of responses you delete from the Form are treated the same way.

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
- the photo and document are uploaded in the background before Submit, so the
  registration request is a few hundred bytes and does no Drive writes;
- the response is saved with one `/formResponse` request instead of ~40 FormApp calls;
- the duplicate check reads a Script Properties index instead of every Form response,
  and all Script Properties are read in one call;
- the upload folder id is cached instead of searched for on every request;
- uploads happen outside the script lock, which is held only for the final check and submit;
- the page warms up the script with a `GET ?warm=1` while the user fills in the form,
  which also refreshes the Form entry map in the background;
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

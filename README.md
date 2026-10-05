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
7. `Display Photo` — File upload
8. `Document` — File upload (image or PDF)

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

Copy the Web app URL.

## 4. Configure the website

Open `index.html` and replace:

PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE

with the Apps Script Web app URL.

Then replace the Apps Script values:

PASTE_YOUR_GOOGLE_FORM_ID_HERE
PASTE_YOUR_GITHUB_PAGES_URL_HERE

`SUCCESS_URL` and `ERROR_URL` should both be the published website URL.

Example:

const SUCCESS_URL = "https://yourname.github.io/shimoga-premier-league-registration/";

## 5. Test before publishing

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

Other checks when the browser still reports CORS:

- Deployment access must be **Anyone**. With "Anyone with Google account" the
  request is redirected to a login page that has no CORS header.
- After editing `Code.gs`, use **Deploy → Manage deployments → Edit → New
  version**. The `/exec` URL keeps serving the old code until you do.
- Run `doPost` once in the Apps Script editor and accept the authorization
  prompt. An unauthorized script returns an error page instead of JSON.

## 6. Free hosting

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

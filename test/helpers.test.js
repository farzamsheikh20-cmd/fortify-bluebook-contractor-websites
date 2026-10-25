import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProfileUrl, emailsFrom, extractWebsite, isBlueBookProfile, profileKey, profilesFromHtml } from '../src/helpers.js';

test('identifies and canonicalizes Blue Book iProView profiles', () => {
  const url = 'https://www.thebluebook.com/iProView/831444/angeles-contractor-inc/subcontractors/locations-contacts/';
  assert.equal(isBlueBookProfile(url), true);
  assert.equal(profileKey(url), '831444');
  assert.equal(canonicalProfileUrl(url), 'https://www.thebluebook.com/iProView/831444/angeles-contractor-inc/');
});

test('discovers unique profiles from listing HTML', () => {
  const html = '<a href="/iProView/831444/angeles-contractor-inc/subcontractors/">A</a><a href="https://www.thebluebook.com/iProView/831444/angeles-contractor-inc/subcontractors/locations-contacts/">B</a>';
  assert.deepEqual(profilesFromHtml(html), ['https://www.thebluebook.com/iProView/831444/angeles-contractor-inc/']);
});

test('extracts a company website only from a labeled website link', () => {
  const links = [
    { text: 'Facebook', href: 'https://facebook.com/example' },
    { text: 'Website', href: 'https://angelescontractor.com/' }
  ];
  assert.equal(extractWebsite('', links), 'https://angelescontractor.com/');
});

test('rejects image filenames and keeps real public emails', () => {
  assert.deepEqual(emailsFrom('cover@2x.png bids@angelescontractor.com bids@angelescontractor.com'), ['bids@angelescontractor.com']);
});

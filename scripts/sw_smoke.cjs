/* Test background push presentation without contacting a push provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
module.exports = async function checkPushWorker() {
  const handlers = {}, shown = [], messages = [], opened = [];
  let focused = 0, closed = 0;
  let windows = [{url: 'https://focus.example.test/overview',
    focus: async () => focused++, postMessage: message => messages.push(message)}];
  const self = {addEventListener: (name, handler) => handlers[name] = handler,
    location: {origin: 'https://focus.example.test'},
    skipWaiting: async () => {},
    registration: {showNotification: async (title, options) => shown.push({title, options})},
    clients: {claim: async () => {}, matchAll: async () => windows, openWindow: async url => opened.push(url)}};
  vm.runInNewContext(fs.readFileSync('static/sw.js', 'utf8'), {self, URL});
  let pending;
  const waitUntil = value => {pending = value;};
  handlers.push({data: {json: () => ({title: 'Focus started', body: 'Write the proposal', tag: 'started:1'})}, waitUntil});
  await pending;
  assert.equal(shown[0].title, 'Focus started');
  assert.equal(shown[0].options.body, 'Write the proposal');
  assert.equal(shown[0].options.tag, 'started:1');
  assert.equal(shown[0].options.icon, '/static/app-icon-192.png');
  assert.equal(messages[0].type, 'timer-push');
  handlers.notificationclick({notification: {close: () => closed++}, waitUntil});
  await pending;
  assert.equal(focused, 1);
  assert.equal(closed, 1);
  assert.equal(opened.length, 0);
  windows = [];
  handlers.notificationclick({notification: {close: () => {}}, waitUntil});
  await pending;
  assert.equal(opened[0], '/');
  handlers.push({data: {json: () => {throw Error('bad payload');}}, waitUntil});
  await pending;
  assert.equal(shown[1].title, 'Paradeis', 'Every push produces a visible notification');
};

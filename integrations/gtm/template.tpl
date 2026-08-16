___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Credible Analytics",
  "categories": ["ANALYTICS"],
  "brand": {
    "id": "brand_dummy",
    "displayName": "Credible"
  },
  "description": "Send pageviews and custom events to a self-hosted Credible instance. Cookieless, no identifiers, no consent banner. Requires the Credible tracker to be on the page — see the notes for the one-time install tag.",
  "containerContexts": [
    "WEB"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "RADIO",
    "name": "tagType",
    "displayName": "What should this tag send?",
    "radioItems": [
      {
        "value": "event",
        "displayValue": "A custom event",
        "help": "A named conversion, such as Signup or Purchase. Fire it from whatever trigger marks the conversion."
      },
      {
        "value": "pageview",
        "displayValue": "A pageview",
        "help": "A virtual pageview: a wizard step, a modal, a route your framework does not push to history. The tracker already counts real navigations on its own, so do NOT fire this on every page or you will count each one twice."
      }
    ],
    "simpleValueType": true,
    "defaultValue": "event"
  },
  {
    "type": "TEXT",
    "name": "eventName",
    "displayName": "Event name",
    "simpleValueType": true,
    "help": "Any string, for example <code>Signup</code>. Create a goal with the same name in your Credible dashboard to see conversions and a conversion rate.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ],
    "enablingConditions": [
      {
        "paramName": "tagType",
        "paramValue": "event",
        "type": "EQUALS"
      }
    ]
  },
  {
    "type": "SIMPLE_TABLE",
    "name": "props",
    "displayName": "Custom properties",
    "simpleTableColumns": [
      {
        "defaultValue": "",
        "displayName": "Property",
        "name": "key",
        "type": "TEXT",
        "isUnique": true,
        "valueValidators": [
          {
            "type": "NON_EMPTY"
          }
        ]
      },
      {
        "defaultValue": "",
        "displayName": "Value",
        "name": "value",
        "type": "TEXT"
      }
    ],
    "help": "Up to 30 are stored per event. Values are kept as text, truncated at 255 characters. Nested structures are not supported."
  },
  {
    "type": "GROUP",
    "name": "revenueGroup",
    "displayName": "Revenue",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      {
        "type": "TEXT",
        "name": "revenueAmount",
        "displayName": "Amount",
        "simpleValueType": true,
        "help": "A number, or a variable holding one, for example {{Transaction Total}}. Leave empty for events with no monetary value."
      },
      {
        "type": "TEXT",
        "name": "revenueCurrency",
        "displayName": "Currency",
        "simpleValueType": true,
        "help": "Three-letter ISO 4217 code, for example EUR. Leave empty to use the currency configured on the site in Credible."
      }
    ],
    "enablingConditions": [
      {
        "paramName": "tagType",
        "paramValue": "event",
        "type": "EQUALS"
      }
    ]
  },
  {
    "type": "GROUP",
    "name": "overrideGroup",
    "displayName": "Overrides",
    "groupStyle": "ZIPPY_CLOSED",
    "subParams": [
      {
        "type": "TEXT",
        "name": "pageUrl",
        "displayName": "Page URL",
        "simpleValueType": true,
        "help": "Report this event against a different URL than the address bar. On a pageview tag this also becomes the URL that engaged time and scroll depth are measured against, until the next pageview."
      },
      {
        "type": "TEXT",
        "name": "referrer",
        "displayName": "Referrer",
        "simpleValueType": true,
        "help": "Override the referrer. Leave empty to keep the real one."
      }
    ]
  },
  {
    "type": "CHECKBOX",
    "name": "debug",
    "checkboxText": "Log what this tag sends to the browser console",
    "simpleValueType": true,
    "help": "For building and debugging. Turn it off before you publish the container."
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

// Credible Analytics — send one pageview or custom event.
//
// This tag talks to window.credible, the global the Credible tracker defines.
// It does NOT load the tracker: Google Tag Manager's sandbox has no API that
// can put a data-* attribute on an injected script, and the Credible tracker
// reads its site domain from data-domain on its own tag. A tag that injected
// the script without one would load happily and then silently drop every
// event, which is worse than not offering it. The tracker is installed once
// with a Custom HTML tag instead — see the notes at the bottom of this
// template, and README.md next to it.
//
// Firing before the tracker has loaded is fine and needs no ordering rules.
// The tracker drains window.credible.q on boot, replays what is in it, and
// then replaces q with a live queue whose push() executes immediately, so the
// same call works at any point in the page's life.

const callInWindow = require('callInWindow');
const copyFromWindow = require('copyFromWindow');
const createArgumentsQueue = require('createArgumentsQueue');
const logToConsole = require('logToConsole');
const makeNumber = require('makeNumber');
const makeTableMap = require('makeTableMap');

const isPageview = data.tagType === 'pageview';

/**
 * { amount, currency } or nothing.
 *
 * An amount that is not a number is dropped rather than sent: the tracker
 * would discard the whole revenue object anyway, and a console line here is
 * how somebody finds out their variable was empty.
 */
const buildRevenue = function () {
  if (isPageview) {
    return undefined;
  }
  const raw = data.revenueAmount;
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  const amount = makeNumber(raw);
  // NaN is the only value in JavaScript not equal to itself.
  if (amount !== amount) {
    logToConsole('Credible: revenue amount "' + raw + '" is not a number, revenue was dropped.');
    return undefined;
  }

  const revenue = { amount: amount };
  if (data.revenueCurrency) {
    revenue.currency = data.revenueCurrency;
  }
  return revenue;
};

/**
 * Assemble the options object window.credible accepts.
 */
const buildOptions = function () {
  const options = {};

  const props = data.props ? makeTableMap(data.props, 'key', 'value') : null;
  if (props) {
    options.props = props;
  }

  const revenue = buildRevenue();
  if (revenue) {
    options.revenue = revenue;
  }

  if (data.pageUrl) {
    options.url = data.pageUrl;
  }
  if (data.referrer) {
    options.referrer = data.referrer;
  }

  return options;
};

/**
 * Hand the event to the tracker, loaded or not.
 *
 * credible.l is the flag the tracker sets on itself once it is running. When
 * it is set we call the real function. When it is not, the async stub is the
 * only safe target: after the tracker boots it replaces credible.q with a
 * live push object rather than an array, and pointing createArgumentsQueue at
 * that could quietly strand the event.
 */
const send = function (name, options) {
  if (data.debug) {
    logToConsole('Credible: sending "' + name + '"', options);
  }

  if (copyFromWindow('credible.l')) {
    callInWindow('credible', name, options);
  } else {
    const queue = createArgumentsQueue('credible', 'credible.q');
    queue(name, options);
  }

  data.gtmOnSuccess();
};

const eventName = isPageview ? 'pageview' : data.eventName;

if (eventName) {
  send(eventName, buildOptions());
} else {
  logToConsole('Credible: this tag has no event name, nothing was sent.');
  data.gtmOnFailure();
}


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "access_globals",
        "versionId": "1"
      },
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "key"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  },
                  {
                    "type": 1,
                    "string": "execute"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "credible"
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "key"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  },
                  {
                    "type": 1,
                    "string": "execute"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "credible.q"
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": false
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "key"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  },
                  {
                    "type": 1,
                    "string": "execute"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "credible.l"
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": false
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "logging",
        "versionId": "1"
      },
      "param": [
        {
          "key": "environments",
          "value": {
            "type": 1,
            "string": "debug"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []


___NOTES___

WHY THIS TEMPLATE DOES NOT LOAD THE TRACKER

Google Tag Manager's sandboxed JavaScript can inject a script by URL, with
injectScript(), and that is all: there is no API for creating an element and
setting attributes on it. The Credible tracker reads the site it belongs to
from data-domain on its own script tag. Injected without that attribute, it
loads, defines window.credible, and drops every single event — a tag that
reports success while measuring nothing.

Rather than ship that, the installation is a Custom HTML tag, which can carry
attributes. Once, on All Pages:

  <script>
    window.credible = window.credible || function () {
      (window.credible.q = window.credible.q || []).push(arguments);
    };
  </script>
  <script defer data-domain="example.com"
          src="https://stats.example.com/js/cr.js"></script>

The first block is the async stub. It means an event tag firing before the
tracker has finished loading is queued and replayed rather than lost, which
removes any need for tag sequencing.

After that, this template handles every conversion event, with no JavaScript
in your container and no permission to touch anything but window.credible.

(For comparison: Plausible's own GTM template can inject its script because
their server serves it as /js/<domain>.js and the script reads the domain out
of its own filename. Credible serves one file and reads the attribute. If
Credible ever accepts the domain from its script URL, this template can grow
an install mode; until then, offering one would be pretending.)

SETUP

  1. Templates -> New -> import this file -> Save.
  2. Add the Custom HTML install tag above, trigger: All Pages.
  3. Tags -> New -> Credible Analytics. Pick an event name and a trigger.
  4. Preview, click through the conversion, and watch the request to
     /api/event in the Network tab.

See README.md next to this file for the long version.

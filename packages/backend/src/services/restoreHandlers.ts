// Every domain that registers a restore inverse (services/restoreContract.ts),
// imported for its registration side effect. eventRestore loads this module
// lazily before its first restore or preview, and app boot (src/index.ts)
// imports it too, so a domain's events restore whether or not anything else
// happened to load the domain first. A new registrant is added here, and its
// event types to DOMAIN_RESTORED_EVENT_TYPES in restoreContract.ts.
//
// eventRestore never imports this statically: the registrants reach
// eventRestore through their own imports, which would close a cycle.

import "./tagMembership.js";
import "./functionRefs.js";
import "./backupRestoreUndo.js";

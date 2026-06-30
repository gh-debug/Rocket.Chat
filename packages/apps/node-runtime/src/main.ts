import './lib/loader-hook';

import { setSandboxGlobals, setSandboxRequire } from '@rocket.chat/apps/base-runtime/dist/handlers/app/construct';
import * as Messenger from '@rocket.chat/apps/base-runtime/dist/lib/messenger';
import { startMessageLoop } from '@rocket.chat/apps/base-runtime/dist/messageLoop';

import registerErrorListeners from './error-handlers';
import { stdoutTransport } from './lib/transports/stdoutTransport';

if (!process.argv.includes('--subprocess')) {
	process.stderr.write(
		new TextEncoder().encode(`
            This is a Deno wrapper for Rocket.Chat Apps. It is not meant to be executed stand-alone;
            It is instead meant to be executed as a subprocess by the Apps-Engine framework.
       `),
	);
	process.exit(1001);
}

// This runtime communicates with the Apps-Engine host through stdout
Messenger.setTransport(stdoutTransport);

// The sandbox `require` handed to the app is Node's own global `require`; it
// needs no extra globals beyond the common ones the base eval shell binds.
setSandboxRequire(require);
setSandboxGlobals({});

registerErrorListeners();

void startMessageLoop();

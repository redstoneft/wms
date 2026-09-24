// Ticker for the WebUSB print station: timers inside a worker are not throttled when the tab is in the background.
setInterval(function () { postMessage('tick'); }, 3000);

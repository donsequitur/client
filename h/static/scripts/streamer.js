'use strict';

var uuid = require('node-uuid');

var Socket = require('./websocket');

/**
 * Open a new WebSocket connection to the Hypothesis push notification service.
 * Only one websocket connection may exist at a time, any existing socket is
 * closed.
 *
 * @param $rootScope - Scope used to $apply() app state changes
 *                     resulting from WebSocket messages, in order to update
 *                     appropriate watchers.
 * @param annotationMapper - The local annotation store
 * @param groups - The local groups store
 * @param session - Provides access to read and update the session state
 * @param settings - Application settings
 */
// @ngInject
function Streamer($rootScope, annotationMapper, groups, session, settings) {
  // The randomly generated session UUID
  var clientId = uuid.v4();

  // The socket instance for this Streamer instance
  var socket;

  // Client configuration messages, to be sent each time a new connection is
  // established.
  var configMessages = {};

  function handleAnnotationNotification(message) {
    var action = message.options.action;
    var annotations = message.payload;

    if (annotations.length === 0) {
      return;
    }

    // Discard annotations that aren't from the currently focused group.
    // Unless the action is delete, where we only get an id
    // FIXME: Have the server only send us annotations from the focused
    // group in the first place.
    if (action !== 'delete') {
      annotations = annotations.filter(function (ann) {
        return ann.group === groups.focused().id;
      });
    }

    switch (action) {
    case 'create':
    case 'update':
    case 'past':
      annotationMapper.loadAnnotations(annotations);
      break;
    case 'delete':
      annotationMapper.unloadAnnotations(annotations);
      break;
    }
  }

  function handleSessionChangeNotification(message) {
    session.update(message.model);
  }

  function sendClientConfig () {
    Object.keys(configMessages).forEach(function (key) {
      if (configMessages[key]) {
        socket.send(configMessages[key]);
      }
    });
  }

  /**
   * Send a configuration message to the push notification service.
   * Each message is associated with a key, which is used to re-send
   * configuration data to the server in the event of a reconnection.
   */
  function setConfig(key, configMessage) {
    configMessages[key] = configMessage;
    if (socket && socket.isConnected()) {
      socket.send(configMessage);
    }
  }

  var connect = function () {
    // If we have no URL configured, don't do anything.
    var url = settings.websocketUrl;
    if (!url) {
      return;
    }

    // Open a new socket
    if (socket) {
      socket.close();
    }

    socket = new Socket(url);
    setConfig('client-id', {
      messageType: 'client_id',
      value: clientId,
    });

    socket.on('open', function () {
      sendClientConfig();
    });

    socket.on('error', function (event) {
      console.warn('Error connecting to H push notification service:', event);

      // In development, warn if the connection failure might be due to
      // the app's origin not having been whitelisted in the H service's config.
      //
      // Unfortunately the error event does not provide a way to get at the
      // HTTP status code for HTTP -> WS upgrade requests.
      var websocketHost = new URL(url).hostname;
      if (['localhost', '127.0.0.1'].indexOf(websocketHost) !== -1) {
        console.warn('Check that your H service is configured to allow ' +
                     'WebSocket connections from ' + window.location.origin);
      }
    });

    socket.on('message', function (event) {
      // Wrap message dispatches in $rootScope.$apply() so that
      // scope watches on app state affected by the received message
      // are updated
      //
      // Note: The use of $apply() here will no longer be needed once session
      // state is moved to the Redux store in `annotationUI`.
      $rootScope.$apply(function () {
        var message = JSON.parse(event.data);
        if (!message) {
          return;
        }

        if (message.type === 'annotation-notification') {
          handleAnnotationNotification(message);
        } else if (message.type === 'session-change') {
          handleSessionChangeNotification(message);
        } else {
          console.warn('received unsupported notification', message.type);
        }
      });
    });
  };

  connect();

  this.connect = connect;
  this.clientId = clientId;
  this.setConfig = setConfig;
  this.socket = socket;
}

module.exports = Streamer;

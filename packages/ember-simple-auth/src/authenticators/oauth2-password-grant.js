import { isEmpty } from '@ember/utils';
import { run, later, cancel } from '@ember/runloop';
import { A, makeArray } from '@ember/array';
import { warn } from '@ember/debug';
import { getOwner } from '@ember/application';
import BaseAuthenticator from './base';
import isFastBoot from '../utils/is-fastboot';
import { waitFor } from '@ember/test-waiters';
import { isTesting } from '@embroider/macros';

/**
  Authenticator that conforms to OAuth 2
  ([RFC 6749](http://tools.ietf.org/html/rfc6749)), specifically the _"Resource
  Owner Password Credentials Grant Type"_.

  This authenticator also automatically refreshes access tokens (see
  [RFC 6749, section 6](http://tools.ietf.org/html/rfc6749#section-6)) if the
  server supports it.

  @class OAuth2PasswordGrantAuthenticator
  @extends BaseAuthenticator
  @public
*/
export default BaseAuthenticator.extend({
  /**
    Triggered when the authenticator refreshed the access token (see
    [RFC 6749, section 6](http://tools.ietf.org/html/rfc6749#section-6)).

    @memberof OAuth2PasswordGrantAuthenticator
    @event sessionDataUpdated
    @param {Object} data The updated session data
    @public
  */

  /**
    The client_id to be sent to the authentication server (see
    https://tools.ietf.org/html/rfc6749#appendix-A.1).

    This should only be
    used for statistics or logging etc. as it cannot actually be trusted since
    it could have been manipulated on the client!

    @memberof OAuth2PasswordGrantAuthenticator
    @property clientId
    @type String
    @default null
    @public
  */
  clientId: null,

  /**
    The endpoint on the server that authentication and token refresh requests
    are sent to.

    @memberof OAuth2PasswordGrantAuthenticator
    @property serverTokenEndpoint
    @type String
    @default '/token'
    @public
  */
  serverTokenEndpoint: '/token',

  /**
    The endpoint on the server that token revocation requests are sent to. Only
    set this if the server actually supports token revocation. If this is
    `null`, the authenticator will not revoke tokens on session invalidation.

    If token revocation is enabled but fails, session invalidation will be
    intercepted and the session will remain authenticated (see
    {@linkplain OAuth2PasswordGrantAuthenticator.invalidate}.

    @memberof OAuth2PasswordGrantAuthenticator
    @property serverTokenRevocationEndpoint
    @type String
    @default null
    @public
  */
  serverTokenRevocationEndpoint: null,

  /**
    Sets whether the authenticator automatically refreshes access tokens if the
    server supports it.

    @memberof OAuth2PasswordGrantAuthenticator
    @property refreshAccessTokens
    @type Boolean
    @default true
    @public
  */
  refreshAccessTokens: true,

  /**
    Sets whether the authenticator use the scope when refreshing access tokens
    if the server supports it.

    @memberof OAuth2PasswordGrantAuthenticator
    @property refreshAccessTokensWithScope
    @type Boolean
    @default false
    @public
  */
  refreshAccessTokensWithScope: false,

  /**
    The offset time in milliseconds to refresh the access token. This must
    return a random number. This randomization is needed because in case of
    multiple tabs, we need to prevent the tabs from sending refresh token
    request at the same exact moment.

    When overriding this property, make sure to mark the overridden property
    as volatile so it will actually have a different value each time it is
    accessed.

    @memberof OAuth2PasswordGrantAuthenticator
    @property tokenRefreshOffset
    @type Integer
    @default a random number between 5 and 10
    @public
  */
  get tokenRefreshOffset() {
    const min = 5;
    const max = 10;

    return (Math.floor(Math.random() * (max - min)) + min) * 1000;
  },

  _refreshTokenTimeout: null,

  /**
    Restores the session from a session data object; __will return a resolving
    promise when there is a non-empty `access_token` in the session data__ and
    a rejecting promise otherwise.
    If the server issues
    [expiring access tokens](https://tools.ietf.org/html/rfc6749#section-5.1)
    and there is an expired access token in the session data along with a
    refresh token, the authenticator will try to refresh the access token and
    return a promise that resolves with the new access token if the refresh was
    successful. If there is no refresh token or the token refresh is not
    successful, a rejecting promise will be returned.

    @memberof OAuth2PasswordGrantAuthenticator
    @method restore
    @param {Object} data The data to restore the session from
    @return {Promise} A promise that when it resolves results in the session becoming or remaining authenticated. If restoration fails, the promise will reject with the server response (in case the access token had expired and was refreshed using a refresh token); however, the authenticator reads that response already so if you need to read it again you need to clone the response object first
    @public
  */
  restore(data) {
    return new Promise((resolve, reject) => {
      const now = new Date().getTime();
      const refreshAccessTokens = this.get('refreshAccessTokens');
      if (!isEmpty(data['expires_at']) && data['expires_at'] < now) {
        if (refreshAccessTokens) {
          this._refreshAccessToken(data['expires_in'], data['refresh_token'], data['scope']).then(
            resolve,
            reject
          );
        } else {
          reject();
        }
      } else {
        if (!this._validate(data)) {
          reject();
        } else {
          this._scheduleAccessTokenRefresh(
            data['expires_in'],
            data['expires_at'],
            data['refresh_token']
          );
          resolve(data);
        }
      }
    });
  },

  /**
    Authenticates the session with the specified `identification`, `password`
    and optional `scope`; issues a `POST` request to the
    {@linkplain OAuth2PasswordGrantAuthenticator.serverTokenEndpoint}
    and receives the access token in response (see
    {@link https://tools.ietf.org/html/rfc6749#section-4.3}).

    If the credentials are valid (and the optionally requested scope is
    granted) and thus authentication succeeds, a promise that resolves with the
    server's response is returned, otherwise a promise that rejects with the
    error as returned by the server is returned.

    If the
    [server supports it]{@link https://tools.ietf.org/html/rfc6749#section-5.1}, this
    method also schedules refresh requests for the access token before it
    expires.

    The server responses are expected to look as defined in the spec (see
    http://tools.ietf.org/html/rfc6749#section-5). The response to a successful
    authentication request should be:

    ```json
    HTTP/1.1 200 OK
    Content-Type: application/json;charset=UTF-8

    {
      "access_token":"2YotnFZFEjr1zCsicMWpAA",
      "token_type":"bearer",
      "expires_in":3600, // optional
      "refresh_token":"tGzv3JOkF0XG5Qx2TlKWIA" // optional
    }
    ```

    The response for a failing authentication request should be:

    ```json
    HTTP/1.1 400 Bad Request
    Content-Type: application/json;charset=UTF-8

    {
      "error":"invalid_grant"
    }
    ```

    A full list of error codes can be found
    [here](https://tools.ietf.org/html/rfc6749#section-5.2).

    @memberof OAuth2PasswordGrantAuthenticator
    @method authenticate
    @param {String} identification The resource owner username
    @param {String} password The resource owner password
    @param {String|Array} scope The scope of the access request (see [RFC 6749, section 3.3](http://tools.ietf.org/html/rfc6749#section-3.3))
    @param {Object} headers Optional headers that particular backends may require (for example sending 2FA challenge responses)
    @return {Promise} A promise that when it resolves results in the session becoming authenticated. If authentication fails, the promise will reject with the server response; however, the authenticator reads that response already so if you need to read it again you need to clone the response object first
    @public
  */
  authenticate(identification, password, scope = [], headers = {}) {
    return new Promise((resolve, reject) => {
      const data = { grant_type: 'password', username: identification, password };
      const serverTokenEndpoint = this.get('serverTokenEndpoint');

      const scopesString = makeArray(scope).join(' ');
      if (!isEmpty(scopesString)) {
        data.scope = scopesString;
      }
      this.makeRequest(serverTokenEndpoint, data, headers).then(
        response => {
          run(() => {
            if (!this._validate(response)) {
              reject('access_token is missing in server response');
            }

            const expiresAt = this._absolutizeExpirationTime(response['expires_in']);
            this._scheduleAccessTokenRefresh(
              response['expires_in'],
              expiresAt,
              response['refresh_token']
            );
            if (!isEmpty(expiresAt)) {
              response = Object.assign(response, { expires_at: expiresAt });
            }

            resolve(response);
          });
        },
        response => {
          run(null, reject, response);
        }
      );
    });
  },

  /**
    If token revocation is enabled, this will revoke the access token (and the
    refresh token if present). If token revocation succeeds, this method
    returns a resolving promise, otherwise it will return a rejecting promise,
    thus intercepting session invalidation.

    If token revocation is not enabled this method simply returns a resolving
    promise.

    @memberof OAuth2PasswordGrantAuthenticator
    @method invalidate
    @param {Object} data The current authenticated session data
    @return {Promise} A promise that when it resolves results in the session being invalidated. If invalidation fails, the promise will reject with the server response (in case token revocation is used); however, the authenticator reads that response already so if you need to read it again you need to clone the response object first
    @public
  */
  invalidate(data) {
    const serverTokenRevocationEndpoint = this.get('serverTokenRevocationEndpoint');
    function success(resolve) {
      cancel(this._refreshTokenTimeout);
      delete this._refreshTokenTimeout;
      resolve();
    }
    return new Promise(resolve => {
      if (isEmpty(serverTokenRevocationEndpoint)) {
        success.apply(this, [resolve]);
      } else {
        const requests = [];
        A(['access_token', 'refresh_token']).forEach(tokenType => {
          const token = data[tokenType];
          if (!isEmpty(token)) {
            requests.push(
              this.makeRequest(serverTokenRevocationEndpoint, {
                token_type_hint: tokenType,
                token,
              })
            );
          }
        });
        const succeed = () => {
          success.apply(this, [resolve]);
        };
        Promise.all(requests).then(succeed, succeed);
      }
    });
  },

  /**
    Makes a request to the OAuth 2.0 server.

    @memberof OAuth2PasswordGrantAuthenticator
    @method makeRequest
    @param {String} url The request URL
    @param {Object} data The request data
    @param {Object} headers Additional headers to send in request
    @return {Promise} A promise that resolves with the response object
    @protected
  */
  makeRequest: waitFor(function (url, data, headers = {}) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const clientId = this.get('clientId');
    if (!isEmpty(clientId)) {
      data['client_id'] = this.get('clientId');
    }

    const body = Object.keys(data)
      .map(key => {
        return `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`;
      })
      .join('&');

    const options = {
      body,
      headers,
      method: 'POST',
    };

    return new Promise((resolve, reject) => {
      fetch(url, options)
        .then(response => {
          response.text().then(text => {
            try {
              let json = JSON.parse(text);
              if (!response.ok) {
                response.responseJSON = json;
                reject(response);
              } else {
                resolve(json);
              }
            } catch (SyntaxError) {
              response.responseText = text;
              reject(response);
            }
          });
        })
        .catch(reject);
    });
  }),

  _scheduleAccessTokenRefresh(expiresIn, expiresAt, refreshToken) {
    const refreshAccessTokens = this.get('refreshAccessTokens') && !isFastBoot(getOwner(this));
    if (refreshAccessTokens) {
      const now = new Date().getTime();
      if (isEmpty(expiresAt) && !isEmpty(expiresIn)) {
        expiresAt = new Date(now + expiresIn * 1000).getTime();
      }
      const offset = this.get('tokenRefreshOffset');
      if (!isEmpty(refreshToken) && !isEmpty(expiresAt) && expiresAt > now - offset) {
        cancel(this._refreshTokenTimeout);
        delete this._refreshTokenTimeout;
        if (!isTesting()) {
          this._refreshTokenTimeout = later(
            this,
            this._refreshAccessToken,
            expiresIn,
            refreshToken,
            expiresAt - now - offset
          );
        }
      }
    }
  },

  _refreshAccessToken(expiresIn, refreshToken, scope) {
    const data = { grant_type: 'refresh_token', refresh_token: refreshToken };
    const refreshAccessTokensWithScope = this.get('refreshAccessTokensWithScope');
    if (refreshAccessTokensWithScope && !isEmpty(scope)) {
      data.scope = scope;
    }

    const serverTokenEndpoint = this.get('serverTokenEndpoint');
    return new Promise((resolve, reject) => {
      this.makeRequest(serverTokenEndpoint, data).then(
        response => {
          run(() => {
            expiresIn = response['expires_in'] || expiresIn;
            refreshToken = response['refresh_token'] || refreshToken;
            scope = response['scope'] || scope;
            const expiresAt = this._absolutizeExpirationTime(expiresIn);
            const data = Object.assign(response, {
              expires_in: expiresIn,
              expires_at: expiresAt,
              refresh_token: refreshToken,
            });
            if (refreshAccessTokensWithScope && !isEmpty(scope)) {
              data.scope = scope;
            }
            this._scheduleAccessTokenRefresh(expiresIn, null, refreshToken);
            this.trigger('sessionDataUpdated', data);
            resolve(data);
          });
        },
        response => {
          warn(
            `Access token could not be refreshed - server responded with ${response.responseJSON}.`,
            false,
            { id: 'ember-simple-auth.failedOAuth2TokenRefresh' }
          );
          reject();
        }
      );
    });
  },

  _absolutizeExpirationTime(expiresIn) {
    if (!isEmpty(expiresIn)) {
      return new Date(new Date().getTime() + expiresIn * 1000).getTime();
    }
  },

  _validate(data) {
    return !isEmpty(data['access_token']);
  },
});

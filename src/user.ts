'use strict';
import {
  arrayUnion,
  capitalizeFirstLetter,
  getExpiredSessions,
  getSessions,
  hashPassword,
  hashToken,
  hyphenizeUUID,
  URLSafeUUID,
  verifyPassword
} from './util';
import {
  CouchDbAuthDoc,
  SessionObj,
  SlLoginSession,
  SlRefreshSession,
  SlRequest,
  SlUserDoc,
  SlUserNew
} from './types/typings';
import Model, { Sofa } from '@sl-nx/sofa-model';

import { ConfigHelper } from './config/configure';
import { DBAuth } from './dbauth';
import { DocumentScope } from 'nano';
import { EventEmitter } from 'events';
import { Mailer } from './mailer';
import merge from 'deepmerge';
import { Request } from 'express';
import { Session } from './session';
import url from 'url';
import { v4 as uuidv4 } from 'uuid';

// regexp from https://emailregex.com/
const EMAIL_REGEXP = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const USER_REGEXP = /^[a-z0-9_-]{3,16}$/;
enum Cleanup {
  'expired' = 'expired',
  'other' = 'other',
  'all' = 'all'
}

export class User {
  #dbAuth: DBAuth;
  #session: Session;
  #onCreateActions;
  #onLinkActions;

  // config flags
  tokenLife: number;
  sessionLife: number;
  useDbFallback: boolean;

  passwordConstraints;
  // validation funs. todo: implement via bind...
  validateUsername: Function;
  validateEmail: Function;

  userModel: Sofa.AsyncOptions;
  resetPasswordModel: Sofa.AsyncOptions;
  changePasswordModel: Sofa.AsyncOptions;

  constructor(
    protected config: ConfigHelper,
    protected userDB: DocumentScope<SlUserDoc>,
    couchAuthDB: DocumentScope<CouchDbAuthDoc>,
    protected mailer: Mailer,
    protected emitter: EventEmitter
  ) {
    const dbAuth = new DBAuth(config, userDB, couchAuthDB);
    this.#dbAuth = dbAuth;
    this.#session = new Session(config);
    this.#onCreateActions = [];
    this.#onLinkActions = [];

    // Token valid for 24 hours by default
    // Forget password token life
    this.tokenLife = config.getItem('security.tokenLife') || 86400;
    // Session token life
    this.sessionLife = config.getItem('security.sessionLife') || 86400;
    this.useDbFallback = config.getItem('session.dbFallback');

    this.passwordConstraints = {
      presence: true,
      length: {
        minimum: 6,
        message: 'must be at least 6 characters'
      },
      matches: 'confirmPassword'
    };
    const additionalConstraints = config.getItem('local.passwordConstraints');
    this.passwordConstraints = merge(
      this.passwordConstraints,
      additionalConstraints ? additionalConstraints : {}
    );

    // the validation functions are public
    this.validateUsername = async function (username) {
      if (!username) {
        return;
      }
      if (username.startsWith('_') || !username.match(USER_REGEXP)) {
        return 'Invalid username';
      }
      try {
        const result = await userDB.view('auth', 'username', { key: username });
        if (result.rows.length === 0) {
          // Pass!
          return;
        } else {
          return 'already in use';
        }
      } catch (err) {
        throw new Error(err);
      }
    };

    this.validateEmail = async function (email): Promise<string | void> {
      if (!email) {
        return;
      }
      if (!email.match(EMAIL_REGEXP)) {
        return 'invalid email';
      }
      try {
        const result = await userDB.view('auth', 'email', { key: email });
        if (result.rows.length === 0) {
          // Pass!
          return;
        } else {
          return 'already in use';
        }
      } catch (err) {
        throw new Error(err);
      }
    };

    // SofaModelOptions
    const userModel: Sofa.AsyncOptions = {
      async: true,
      whitelist: ['name', 'username', 'email', 'password', 'confirmPassword'],
      customValidators: {
        validateEmail: this.validateEmail,
        matches: this.matches
      },
      sanitize: {
        name: ['trim'],
        username: ['trim', 'toLowerCase'],
        email: ['trim', 'toLowerCase']
      },
      validate: {
        email: {
          presence: true,
          validateEmail: true
        },
        password: this.passwordConstraints,
        confirmPassword: {
          presence: true
        }
      },
      static: {
        type: 'user',
        roles: config.getItem('security.defaultRoles'),
        providers: ['local']
      },
      rename: {}
    };

    this.userModel = userModel;

    this.resetPasswordModel = {
      async: true,
      customValidators: {
        matches: this.matches
      },
      validate: {
        token: {
          presence: true
        },
        password: this.passwordConstraints,
        confirmPassword: {
          presence: true
        }
      }
    };

    this.changePasswordModel = {
      async: true,
      customValidators: {
        matches: this.matches
      },
      validate: {
        newPassword: this.passwordConstraints,
        confirmPassword: {
          presence: true
        }
      }
    };
  }

  /**
   * Use this to add as many functions as you want to transform the new user document before it is saved.
   * Your function should accept two arguments (userDoc, provider) and return a Promise that resolves to the modified user document.
   * onCreate functions will be chained in the order they were added.
   * @param {Function} fn
   */
  onCreate(fn) {
    if (typeof fn === 'function') {
      this.#onCreateActions.push(fn);
    } else {
      throw new TypeError('onCreate: You must pass in a function');
    }
  }

  /**
   * Does the same thing as onCreate, but is called every time a user links a new provider, or their profile information is refreshed.
   * This allows you to process profile information and, for example, create a master profile.
   * If an object called profile exists inside the user doc it will be passed to the client along with session information at each login.
   * @param {Function} fn
   */
  onLink(fn) {
    if (typeof fn === 'function') {
      this.#onLinkActions.push(fn);
    } else {
      throw new TypeError('onLink: You must pass in a function');
    }
  }

  /** Validation function for ensuring that two fields match */
  matches(value, option, key, attributes) {
    if (attributes && attributes[option] !== value) {
      return 'does not match ' + option;
    }
  }

  processTransformations(fnArray, userDoc, provider) {
    let promise;
    fnArray.forEach(fn => {
      if (!promise) {
        promise = fn.call(null, userDoc, provider);
      } else {
        if (!promise.then || typeof promise.then !== 'function') {
          throw new Error('onCreate function must return a promise');
        }
        promise.then(newUserDoc => {
          return fn.call(null, newUserDoc, provider);
        });
      }
    });
    if (!promise) {
      promise = Promise.resolve(userDoc);
    }
    return promise;
  }

  /** retrieves by email or username */
  getUser(login: string): Promise<SlUserDoc | null> {
    const query = EMAIL_REGEXP.test(login) ? 'email' : 'username';
    return this.userDB
      .view('auth', query, { key: login, include_docs: true })
      .then(results => {
        if (results.rows.length > 0) {
          return Promise.resolve(results.rows[0].doc);
        } else {
          return Promise.resolve(null);
        }
      });
  }

  createUser(form, req) {
    req = req || {};
    let finalUserModel = this.userModel;
    const newUserModel = this.config.getItem('userModel');
    if (typeof newUserModel === 'object') {
      let whitelist;
      if (newUserModel.whitelist) {
        whitelist = arrayUnion(
          this.userModel.whitelist,
          newUserModel.whitelist
        );
      }
      const addUserModel = this.config.getItem('userModel');
      finalUserModel = merge(this.userModel, addUserModel ? addUserModel : {});
      finalUserModel.whitelist = whitelist || finalUserModel.whitelist;
    }
    const UserModel = Model(finalUserModel);
    const user = new UserModel(form);
    let newUser: Partial<SlUserNew>;
    return user
      .process()
      .then(result => {
        newUser = result;
        const uid = uuidv4();
        // todo: remove, this is just for backwards compat
        if (this.config.getItem('local.sendNameAndUUID')) {
          newUser.user_uid = uid;
        }
        newUser._id = uid.split('-').join('');
        if (this.config.getItem('local.sendConfirmEmail')) {
          newUser.unverifiedEmail = {
            email: newUser.email,
            token: URLSafeUUID()
          };
          delete newUser.email;
        }
        return hashPassword(newUser.password);
      })
      .catch(err => {
        console.log('validation failed.');
        return Promise.reject({
          error: 'Validation failed',
          validationErrors: err,
          status: 400
        });
      })
      .then(hash => {
        // Store password hash
        newUser.local = {};
        newUser.local.salt = hash.salt;
        newUser.local.derived_key = hash.derived_key;
        delete newUser.password;
        delete newUser.confirmPassword;
        newUser.signUp = {
          provider: 'local',
          timestamp: new Date().toISOString()
        };
        return this.addUserDBs(newUser as SlUserDoc);
      })
      .then(newUser => {
        return this.logActivity(newUser._id, 'signup', 'local', newUser);
      })
      .then(newUser => {
        return this.processTransformations(
          this.#onCreateActions,
          newUser,
          'local'
        );
      })
      .then(finalNewUser => {
        return this.userDB.insert(finalNewUser);
      })
      .then(result => {
        newUser._rev = result.rev;
        if (!this.config.getItem('local.sendConfirmEmail')) {
          return Promise.resolve();
        }
        return this.mailer.sendEmail(
          'confirmEmail',
          newUser.unverifiedEmail.email,
          { req: req, user: newUser }
        );
      })
      .then(() => {
        this.emitter.emit('signup', newUser, 'local');
        return Promise.resolve(newUser);
      });
  }

  /**
   * Creates a new user following authentication from an OAuth provider. If the user already exists it will update the profile.
   * @param {string} provider the name of the provider in lowercase, (e.g. 'facebook')
   * @param {any} auth credentials supplied by the provider
   * @param {any} profile the profile supplied by the provider
   * @param {any} req used just to log the user's ip if supplied
   */
  socialAuth(provider, auth, profile, req) {
    let user: Partial<SlUserDoc>;
    let newAccount = false;
    let action;
    req = req || {};
    // This used to be consumped by `.nodeify` from Bluebird. I hope `callbackify` works just as well...
    return Promise.resolve()
      .then(() => {
        return this.userDB.view('auth', provider, {
          key: profile.id,
          include_docs: true
        });
      })
      .then(results => {
        if (results.rows.length > 0) {
          user = results.rows[0].doc;
          return Promise.resolve();
        } else {
          newAccount = true;
          if (!profile.emails) {
            return Promise.reject({
              error: 'No email provided',
              message: `An email is required for registration, but ${provider} didn't supply one.`,
              status: 400
            });
          }
          user = {
            email: profile.emails[0].value,
            providers: [provider],
            type: 'user',
            roles: this.config.getItem('security.defaultRoles'),
            signUp: {
              provider: provider,
              timestamp: new Date().toISOString()
            }
          };
          user[provider] = {};
          return this.validateEmail(user.email).then(err => {
            if (err) {
              return Promise.reject({
                error: 'Email already in use',
                message:
                  'Your email is already in use. Try signing in first and then linking this account.',
                status: 409
              });
            }
            return Promise.resolve();
          });
        }
      })
      .then(() => {
        user[provider].auth = auth;
        user[provider].profile = profile;
        if (!user.name) {
          user.name = profile.displayName;
        }
        delete user[provider].profile._raw;
        if (newAccount) {
          user._id = uuidv4().split('-').join('');
          return this.addUserDBs(user as SlUserDoc);
        } else {
          return Promise.resolve(user as SlUserDoc);
        }
      })
      .then(userDoc => {
        action = newAccount ? 'signup' : 'login';
        return this.logActivity(userDoc._id, action, provider, userDoc);
      })
      .then(userDoc => {
        if (newAccount) {
          return this.processTransformations(
            this.#onCreateActions,
            userDoc,
            provider
          );
        } else {
          return this.processTransformations(
            this.#onLinkActions,
            userDoc,
            provider
          );
        }
      })
      .then(finalUser => {
        return this.userDB.insert(finalUser);
      })
      .then(() => {
        if (action === 'signup') {
          this.emitter.emit('signup', user, provider);
        }
        return Promise.resolve(user);
      });
  }

  linkSocial(user_uid, provider, auth, profile, req) {
    req = req || {};
    let user: SlUserDoc;
    // Load user doc
    return Promise.resolve()
      .then(() => {
        return this.userDB.view('auth', provider, { key: profile.id });
      })
      .then(results => {
        if (results.rows.length === 0) {
          return Promise.resolve();
        } else {
          if (results.rows[0].id !== user_uid) {
            return Promise.reject({
              error: 'Conflict',
              message:
                'This ' +
                provider +
                ' profile is already in use by another account.',
              status: 409
            });
          }
        }
      })
      .then(() => {
        return this.userDB.get(user_uid);
      })
      .then(theUser => {
        user = theUser;
        // Check for conflicting provider
        if (user[provider] && user[provider].profile.id !== profile.id) {
          return Promise.reject({
            error: 'Conflict',
            message:
              'Your account is already linked with another ' +
              provider +
              'profile.',
            status: 409
          });
        }
        // Check email for conflict
        if (!profile.emails) {
          return Promise.resolve({ rows: [] });
        }
        return this.userDB.view('auth', 'email', {
          key: profile.emails[0].value
        });
      })
      .then(results => {
        let passed;
        if (results.rows.length === 0) {
          passed = true;
        } else {
          passed = true;
          results.rows.forEach(row => {
            if (row.id !== user_uid) {
              passed = false;
            }
          });
        }
        if (!passed) {
          return Promise.reject({
            error: 'Conflict',
            message:
              'The email ' +
              profile.emails[0].value +
              ' is already in use by another account.',
            status: 409
          });
        } else {
          return Promise.resolve();
        }
      })
      .then(() => {
        // Insert provider info
        user[provider] = {};
        user[provider].auth = auth;
        user[provider].profile = profile;
        if (!user.providers) {
          user.providers = [];
        }
        if (user.providers.indexOf(provider) === -1) {
          user.providers.push(provider);
        }
        if (!user.name) {
          user.name = profile.displayName;
        }
        delete user[provider].profile._raw;
        return this.logActivity(user._id, 'link', provider, user);
      })
      .then(userDoc => {
        return this.processTransformations(
          this.#onLinkActions,
          userDoc,
          provider
        );
      })
      .then(finalUser => {
        return this.userDB.insert(finalUser);
      })
      .then(() => {
        return Promise.resolve(user);
      });
  }

  /**
   * Removes the specified provider from the user's account. Local cannot be removed. If there is only one provider left it will fail.
   * Returns the modified user, if successful.
   * @param {string} user_id
   * @param {string} provider
   */
  unlink(user_id, provider) {
    let user;
    return this.userDB
      .get(user_id)
      .then(theUser => {
        user = theUser;
        if (!provider) {
          return Promise.reject({
            error: 'Unlink failed',
            message: 'You must specify a provider to unlink.',
            status: 400
          });
        }
        // We can only unlink if there are at least two providers
        if (
          !user.providers ||
          !(user.providers instanceof Array) ||
          user.providers.length < 2
        ) {
          return Promise.reject({
            error: 'Unlink failed',
            message: "You can't unlink your only provider!",
            status: 400
          });
        }
        // We cannot unlink local
        if (provider === 'local') {
          return Promise.reject({
            error: 'Unlink failed',
            message: "You can't unlink local.",
            status: 400
          });
        }
        // Check that the provider exists
        if (!user[provider] || typeof user[provider] !== 'object') {
          return Promise.reject({
            error: 'Unlink failed',
            message:
              'Provider: ' + capitalizeFirstLetter(provider) + ' not found.',
            status: 404
          });
        }
        delete user[provider];
        // Remove the unlinked provider from the list of providers
        user.providers.splice(user.providers.indexOf(provider), 1);
        return this.userDB.insert(user);
      })
      .then(() => {
        return Promise.resolve(user);
      });
  }

  /**
   * Creates a new session for a user. provider is the name of the provider. (eg. 'local', 'facebook', twitter.)
   * req is used to log the IP if provided.
   */
  async createSession(user_uid: string, provider: string, req: any = {}) {
    let user = await this.userDB.get(user_uid);
    const token = await this.generateSession(user_uid, user.roles);
    const password = token.password;
    const newToken = token;
    newToken.provider = provider;
    //await this.#session.storeToken(newToken);
    await this.#dbAuth.storeKey(
      user_uid,
      newToken.key,
      password,
      newToken.expires,
      user.roles,
      provider
    );
    // authorize the new session across all dbs
    if (user.personalDBs) {
      await this.#dbAuth.authorizeUserSessions(
        user_uid,
        user.personalDBs,
        newToken.key,
        user.roles
      );
    }
    if (!user.session) {
      user.session = {};
    }
    const newSession: Partial<SlLoginSession> = {
      issued: newToken.issued,
      expires: newToken.expires,
      provider: provider
    };
    user.session[newToken.key] = newSession as SessionObj;
    // Clear any failed login attempts
    if (provider === 'local') {
      if (!user.local) user.local = {};
      user.local.failedLoginAttempts = 0;
      delete user.local.lockedUntil;
    }
    const userDoc = await this.logActivity(user_uid, 'login', provider, user);
    // Clean out expired sessions on login
    const finalUser = await this.logoutUserSessions(userDoc, Cleanup.expired);
    user = finalUser;
    await this.userDB.insert(finalUser);
    newSession.token = newToken.key;
    newSession.password = password;
    newSession.user_id = user._id;
    newSession.roles = user.roles;
    // Inject the list of userDBs
    if (typeof user.personalDBs === 'object') {
      const userDBs = {};
      let publicURL;
      if (this.config.getItem('dbServer.publicURL')) {
        const dbObj = url.parse(this.config.getItem('dbServer.publicURL'));
        dbObj.auth = newSession.token + ':' + newSession.password;
        publicURL = url.format(dbObj);
      } else {
        publicURL =
          this.config.getItem('dbServer.protocol') +
          newSession.token +
          ':' +
          newSession.password +
          '@' +
          this.config.getItem('dbServer.host') +
          '/';
      }
      Object.keys(user.personalDBs).forEach(finalDBName => {
        userDBs[user.personalDBs[finalDBName].name] = publicURL + finalDBName;
      });
      newSession.userDBs = userDBs;
    }
    if (user.profile) {
      newSession.profile = user.profile;
    }
    // New config option: also send name and user_uid
    if (this.config.getItem('local.sendNameAndUUID')) {
      if (user.name) {
        newSession.name = user.name;
      }
      newSession.user_uid = hyphenizeUUID(user._id);
    }
    this.emitter.emit('login', newSession, provider);
    return newSession as SlLoginSession;
  }

  handleFailedLogin(user: SlUserDoc, req: Partial<Request>) {
    req = req || {};
    const maxFailedLogins = this.config.getItem('security.maxFailedLogins');
    if (!maxFailedLogins) {
      return Promise.resolve();
    }
    if (!user.local) {
      user.local = {};
    }
    if (!user.local.failedLoginAttempts) {
      user.local.failedLoginAttempts = 0;
    }
    user.local.failedLoginAttempts++;
    if (user.local.failedLoginAttempts > maxFailedLogins) {
      user.local.failedLoginAttempts = 0;
      user.local.lockedUntil =
        Date.now() + this.config.getItem('security.lockoutTime') * 1000;
    }
    return this.logActivity(user._id, 'failed login', 'local', user)
      .then(finalUser => {
        return this.userDB.insert(finalUser);
      })
      .then(() => {
        return Promise.resolve(!!user.local.lockedUntil);
      });
  }

  logActivity(
    user_id: string,
    action: string,
    provider: string,
    userDoc: SlUserDoc,
    saveDoc?: boolean
  ): Promise<SlUserDoc> {
    const logSize = this.config.getItem('security.userActivityLogSize');
    if (!logSize) {
      return Promise.resolve(userDoc);
    }
    let promise;
    if (userDoc) {
      promise = Promise.resolve(userDoc);
    } else {
      if (saveDoc !== false) {
        saveDoc = true;
      }
      promise = this.userDB.get(user_id);
    }
    return promise.then(theUser => {
      userDoc = theUser;
      if (!userDoc.activity || !(userDoc.activity instanceof Array)) {
        userDoc.activity = [];
      }
      const entry = {
        timestamp: new Date().toISOString(),
        action: action,
        provider: provider
      };
      userDoc.activity.unshift(entry);
      while (userDoc.activity.length > logSize) {
        userDoc.activity.pop();
      }
      if (saveDoc) {
        return this.userDB.insert(userDoc).then(() => {
          return Promise.resolve(userDoc);
        });
      } else {
        return Promise.resolve(userDoc);
      }
    });
  }

  /**
   * Extends the life of your current token and returns updated token information.
   * The only field that will change is expires. Expired sessions are removed.
   * todo:
   * - handle error if invalid state occurs that doc is not present.
   * - I'd need to store salts & derived keys within sl-users as well for staying
   *   compatible with legacy auth on cloudant
   * - ensure that ip is removed/ not sent
   */
  async refreshSession(key: string): Promise<SlRefreshSession> {
    const userDoc = await this.findUserDocBySession(key);
    userDoc.session[key].expires = Date.now() + this.sessionLife * 1000;
    // Clean out expired sessions on refresh
    const finalUser = await this.logoutUserSessions(userDoc, Cleanup.expired);
    await this.userDB.insert(finalUser);
    const newSession: SlRefreshSession = {
      ...userDoc.session[key],
      token: key,
      user_id: userDoc._id,
      roles: userDoc.roles
    };
    delete newSession['ip'];
    this.emitter.emit('refresh', newSession);
    return newSession;
  }

  /**
   * Required form fields: token, password, and confirmPassword
   */
  resetPassword(form, req: Partial<Request> = undefined): Promise<SlUserDoc> {
    req = req || {};
    const ResetPasswordModel = Model(this.resetPasswordModel);
    const passwordResetForm = new ResetPasswordModel(form);
    let user;
    return passwordResetForm
      .validate()
      .then(
        () => {
          const tokenHash = hashToken(form.token);
          return this.userDB.view('auth', 'passwordReset', {
            key: tokenHash,
            include_docs: true
          });
        },
        err => {
          return Promise.reject({
            error: 'Validation failed',
            validationErrors: err,
            status: 400
          });
        }
      )
      .then(results => {
        if (!results.rows.length) {
          return Promise.reject({ status: 400, error: 'Invalid token' });
        }
        user = results.rows[0].doc;
        if (user.forgotPassword.expires < Date.now()) {
          return Promise.reject({ status: 400, error: 'Token expired' });
        }
        return hashPassword(form.password);
      })
      .then(hash => {
        if (!user.local) {
          user.local = {};
        }
        user.local.salt = hash.salt;
        user.local.derived_key = hash.derived_key;
        if (user.providers.indexOf('local') === -1) {
          user.providers.push('local');
        }
        // logout user completely
        return this.logoutUserSessions(user, Cleanup.all);
      })
      .then(async userDoc => {
        user = userDoc;
        delete user.forgotPassword;
        if (user.unverifiedEmail) {
          user = await this.markEmailAsVerified(
            user,
            'verified via password reset',
            req
          );
        }
        return this.logActivity(user._id, 'reset password', 'local', user);
      })
      .then(finalUser => this.userDB.insert(finalUser))
      .then(() => this.sendModifiedPasswordEmail(user, req))
      .then(() => {
        this.emitter.emit('password-reset', user);
        return Promise.resolve(user);
      });
  }

  async changePasswordSecure(user_id: string, form, req) {
    req = req || {};
    const ChangePasswordModel = Model(this.changePasswordModel);
    const changePasswordForm = new ChangePasswordModel(form);
    try {
      await changePasswordForm.validate();
    } catch (err) {
      throw {
        error: 'Validation failed',
        validationErrors: err,
        status: 400
      };
    }

    try {
      const user = await this.userDB.get(user_id);
      if (user.local && user.local.salt && user.local.derived_key) {
        // Password is required
        if (!form.currentPassword) {
          throw {
            error: 'Password change failed',
            message:
              'You must supply your current password in order to change it.',
            status: 400
          };
        }
        await verifyPassword(user.local, form.currentPassword);
      }
      await this.changePassword(user._id, form.newPassword, user, req);
    } catch (err) {
      throw (
        err || {
          error: 'Password change failed',
          message: 'The current password you supplied is incorrect.',
          status: 400
        }
      );
    }
    if (req.user && req.user.key) {
      return this.logoutOthers(req.user.key);
    } else {
      return;
    }
  }

  changePassword(user_id, newPassword, userDoc, req) {
    req = req || {};
    let promise, user;
    if (userDoc) {
      promise = Promise.resolve(userDoc);
    } else {
      promise = this.userDB.get(user_id);
    }
    return promise
      .then(
        doc => {
          user = doc;
          return hashPassword(newPassword);
        },
        err => {
          return Promise.reject({
            error: 'User not found',
            status: 404
          });
        }
      )
      .then(hash => {
        if (!user.local) {
          user.local = {};
        }
        user.local.salt = hash.salt;
        user.local.derived_key = hash.derived_key;
        if (user.providers.indexOf('local') === -1) {
          user.providers.push('local');
        }
        return this.logActivity(user._id, 'changed password', 'local', user);
      })
      .then(finalUser => this.userDB.insert(finalUser))
      .then(() => this.sendModifiedPasswordEmail(user, req))
      .then(() => {
        this.emitter.emit('password-change', user);
      });
  }

  private sendModifiedPasswordEmail(user, req) {
    if (this.config.getItem('local.sendPasswordChangedEmail')) {
      return this.mailer.sendEmail(
        'modifiedPassword',
        user.email || user.unverifiedEmail.email,
        { user: user, req: req }
      );
    } else {
      return Promise.resolve();
    }
  }

  forgotPassword(email: string, req: Partial<Request>) {
    if (!email || !email.match(EMAIL_REGEXP)) {
      return Promise.reject({ error: 'invalid email', status: 400 });
    }
    req = req || {};
    let user: SlUserDoc, token, tokenHash;
    return this.userDB
      .view('auth', 'email', { key: email, include_docs: true })
      .then(result => {
        if (!result.rows.length) {
          return Promise.reject({
            error: 'User not found',
            status: 404
          });
        }
        user = result.rows[0].doc;
        token = URLSafeUUID();
        if (this.config.getItem('local.tokenLengthOnReset')) {
          token = token.substring(
            0,
            this.config.getItem('local.tokenLengthOnReset')
          );
        }
        tokenHash = hashToken(token);
        user.forgotPassword = {
          token: tokenHash, // Store secure hashed token
          issued: Date.now(),
          expires: Date.now() + this.tokenLife * 1000
        };
        return this.logActivity(user._id, 'forgot password', 'local', user);
      })
      .then(finalUser => {
        return this.userDB.insert(finalUser);
      })
      .then(() => {
        return this.mailer.sendEmail(
          'forgotPassword',
          user.email || user.unverifiedEmail.email,
          { user: user, req: req, token: token }
        ); // Send user the unhashed token
      })
      .then(() => {
        this.emitter.emit('forgot-password', user);
        return Promise.resolve(user.forgotPassword);
      });
  }

  verifyEmail(token: string, req: Partial<Request>) {
    req = req || {};
    let user: SlUserDoc;
    return this.userDB
      .view('auth', 'verifyEmail', { key: token, include_docs: true })
      .then(result => {
        if (!result.rows.length) {
          return Promise.reject({ error: 'Invalid token', status: 400 });
        }
        user = result.rows[0].doc;
        return this.markEmailAsVerified(user, 'verified email', req);
      })
      .then(finalUser => {
        return this.userDB.insert(finalUser);
      });
  }

  private async markEmailAsVerified(userDoc, logInfo, req) {
    userDoc.email = userDoc.unverifiedEmail.email;
    delete userDoc.unverifiedEmail;
    this.emitter.emit('email-verified', userDoc);
    return await this.logActivity(userDoc._id, logInfo, 'local', req, userDoc);
  }

  async changeEmail(
    user_id: string,
    newEmail: string,
    req: Partial<SlRequest>
  ) {
    req = req || {};
    if (!req.user) {
      req.user = { provider: 'local' };
    }
    const emailError = await this.validateEmail(newEmail);
    if (emailError) {
      throw emailError;
    }
    const user = await this.userDB.get(user_id);
    if (this.config.getItem('local.sendConfirmEmail')) {
      user.unverifiedEmail = {
        email: newEmail,
        token: URLSafeUUID()
      };
      const mailType = this.config.getItem('emails.confirmEmailChange')
        ? 'confirmEmailChange'
        : 'confirmEmail';
      await this.mailer.sendEmail(mailType, user.unverifiedEmail.email, {
        req: req,
        user: user
      });
    } else {
      user.email = newEmail;
    }
    this.emitter.emit('email-changed', user);
    const finalUser = await this.logActivity(
      user._id,
      'changed email',
      req.user.provider,
      user
    );
    return this.userDB.insert(finalUser);
  }

  async findUserDocBySession(key: string): Promise<SlUserDoc | undefined> {
    const results = await this.userDB.view('auth', 'session', {
      key,
      include_docs: true
    });
    if (results.rows.length > 0) {
      return results.rows[0].doc as SlUserDoc;
    } else {
      return undefined;
    }
  }

  addUserDB(
    user_id: string, // todo: either pass uid or use find here
    dbName: string,
    type: string,
    designDocs,
    permissions: string[]
  ) {
    let userDoc: SlUserDoc;
    const dbConfig = this.#dbAuth.getDBConfig(dbName, type || 'private');
    dbConfig.designDocs = designDocs || dbConfig.designDocs || '';
    dbConfig.permissions = permissions || dbConfig.permissions;
    return this.userDB
      .get(user_id)
      .then(result => {
        userDoc = result;
        return this.#dbAuth.addUserDB(
          userDoc,
          dbName,
          dbConfig.designDocs,
          dbConfig.type,
          dbConfig.permissions,
          dbConfig.adminRoles,
          dbConfig.memberRoles
        );
      })
      .then(finalDBName => {
        if (!userDoc.personalDBs) {
          userDoc.personalDBs = {};
        }
        delete dbConfig.designDocs;
        // If permissions is specified explicitly it will be saved, otherwise will be taken from defaults every session
        if (!permissions) {
          delete dbConfig.permissions;
        }
        delete dbConfig.adminRoles;
        delete dbConfig.memberRoles;
        userDoc.personalDBs[finalDBName] = dbConfig;
        this.emitter.emit('user-db-added', user_id, dbName);
        return this.userDB.insert(userDoc);
      });
  }

  async removeUserDB(
    user_id: string,
    dbName: string,
    deletePrivate,
    deleteShared
  ) {
    let update = false;
    const user = await this.userDB.get(user_id);
    if (user.personalDBs && typeof user.personalDBs === 'object') {
      for (const db of Object.keys(user.personalDBs)) {
        if (user.personalDBs[db].name === dbName) {
          const type = user.personalDBs[db].type;
          delete user.personalDBs[db];
          update = true;
          if (type === 'private' && deletePrivate) {
            await this.#dbAuth.removeDB(dbName);
          }
          if (type === 'shared' && deleteShared) {
            await this.#dbAuth.removeDB(dbName);
          }
        }
      }
    }
    if (update) {
      this.emitter.emit('user-db-removed', user_id, dbName);
      return this.userDB.insert(user);
    }
  }

  logoutUser(user_id, session_id) {
    let promise, user;
    if (user_id) {
      promise = this.userDB.get(user_id);
    } else {
      if (!session_id) {
        return Promise.reject({
          error: 'unauthorized',
          message: 'Either user_id or session_id must be specified',
          status: 401
        });
      }
      promise = this.findUserDocBySession(session_id).then(userDoc => {
        if (!userDoc) {
          return Promise.reject({
            error: 'unauthorized',
            status: 401
          });
        }
        return Promise.resolve(userDoc);
      });
    }
    return promise
      .then(record => {
        user = record;
        user_id = record._id;
        return this.logoutUserSessions(user, Cleanup.all);
      })
      .then(() => {
        this.emitter.emit('logout', user_id);
        this.emitter.emit('logout-all', user_id);
        return this.userDB.insert(user);
      });
  }

  /**
   * todo: Should I really allow to fail after `removeKeys`?
   * -> I'd like my `sl-users` to be single source of truth, don't I?
   */
  async logoutSession(session_id: string) {
    let startSessions = 0;
    let endSessions = 0;
    let user = await this.findUserDocBySession(session_id);
    if (!user) {
      throw {
        error: 'unauthorized',
        status: 401
      };
    }
    if (user.session) {
      startSessions = Object.keys(user.session).length;
      if (user.session[session_id]) {
        delete user.session[session_id];
      }
    }
    // 1.) if this fails, the whole logout has failed! Else ok, will be cleaned up later.
    await this.#dbAuth.removeKeys(session_id);
    let caughtError = {};
    try {
      // 2) deauthorize from user's dbs
      await this.#dbAuth.deauthorizeUser(user, session_id);

      // Clean out expired sessions
      user = await this.logoutUserSessions(user, Cleanup.expired);
      if (user.session) {
        endSessions = Object.keys(user.session).length;
      }
      this.emitter.emit('logout', user._id);
      if (startSessions !== endSessions) {
        // 3) update the sl-doc
        return this.userDB.insert(user);
      } else {
        return false;
      }
    } catch (error) {
      caughtError = {
        err: error.err,
        reason: error.reason,
        statusCode: error.statusCode
      };
      console.warn(
        'Error during logoutSessions() - err: ' +
          error.err +
          ', reason: ' +
          error.reason +
          ', status: ' +
          error.statusCode
      );
    }
    return caughtError;
  }

  async logoutOthers(session_id) {
    const user = await this.findUserDocBySession(session_id);
    if (user) {
      if (user.session && user.session[session_id]) {
        const finalUser = await this.logoutUserSessions(
          user,
          Cleanup.other,
          session_id
        );
        return this.userDB.insert(finalUser);
      }
    }
    return false;
  }

  async logoutUserSessions(
    userDoc: SlUserDoc,
    op: Cleanup,
    currentSession?: string
  ) {
    // When op is 'other' it will logout all sessions except for the specified 'currentSession'
    let sessions;
    if (op === Cleanup.all || op === Cleanup.other) {
      sessions = getSessions(userDoc);
    } else if (op === Cleanup.expired) {
      sessions = getExpiredSessions(userDoc, Date.now());
    }
    if (op === Cleanup.other && currentSession) {
      // Remove the current session from the list of sessions we are going to delete
      const index = sessions.indexOf(currentSession);
      if (index > -1) {
        sessions.splice(index, 1);
      }
    }
    if (sessions.length) {
      // 1.) Remove the keys from our couchDB auth database. Must happen first.
      await this.#dbAuth.removeKeys(sessions);
      // 2.) Deauthorize keys from each personal database and from session store
      await this.#dbAuth.deauthorizeUser(userDoc, sessions);
      if (op === Cleanup.expired || op === Cleanup.other) {
        sessions.forEach(session => {
          delete userDoc.session[session];
        });
      }
    }
    if (op === Cleanup.all) {
      delete userDoc.session;
    }
    return userDoc;
  }

  async removeUser(user_id: string, destroyDBs) {
    const promises = [];
    const userDoc = await this.userDB.get(user_id);
    const user = await this.logoutUserSessions(userDoc, Cleanup.all);
    if (destroyDBs !== true || !user.personalDBs) {
      return Promise.resolve();
    }
    Object.keys(user.personalDBs).forEach(userdb => {
      if (user.personalDBs[userdb].type === 'private') {
        promises.push(this.#dbAuth.removeDB(userdb));
      }
    });
    await Promise.all(promises);
    return this.userDB.destroy(user._id, user._rev);
  }

  /**
   * Confirms the user:password that has been passed as Bearer Token
   * Todo: maybe just look in superlogin-users or try to access DB?
   */
  async confirmSession(key: string, password: string) {
    try {
      const doc = await this.#dbAuth.retrieveKey(key);
      if (doc.expires > Date.now()) {
        const token: any = doc;
        token._id = token.user_id;
        token.key = key;
        delete token.user_id;
        delete token.name;
        delete token.type;
        delete token._rev;
        delete token.password_scheme;
        return this.#session.confirmToken(token, password);
      } else {
        this.#dbAuth.removeKeys(key);
      }
    } catch {}
    throw Session.invalidMsg;
  }

  generateSession(user_uid: string, roles: string[]) {
    return this.#dbAuth.getApiKey().then(key => {
      const now = Date.now();
      return Promise.resolve({
        _id: user_uid,
        key: key.key,
        password: key.password,
        issued: now,
        expires: now + this.sessionLife * 1000,
        roles: roles
      });
    });
  }

  addUserDBs(newUser: SlUserDoc) {
    // Add personal DBs
    if (!this.config.getItem('userDBs.defaultDBs')) {
      return Promise.resolve(newUser);
    }
    const promises = [];
    newUser.personalDBs = {};

    const processUserDBs = (dbList, type) => {
      dbList.forEach(userDBName => {
        const dbConfig = this.#dbAuth.getDBConfig(userDBName);
        promises.push(
          this.#dbAuth
            .addUserDB(
              newUser,
              userDBName,
              dbConfig.designDocs,
              type,
              dbConfig.permissions,
              dbConfig.adminRoles,
              dbConfig.memberRoles
            )
            .then(finalDBName => {
              delete dbConfig.permissions;
              delete dbConfig.adminRoles;
              delete dbConfig.memberRoles;
              delete dbConfig.designDocs;
              dbConfig.type = type;
              newUser.personalDBs[finalDBName] = dbConfig;
            })
        );
      });
    };

    // Just in case defaultDBs is not specified
    let defaultPrivateDBs = this.config.config.userDBs?.defaultDBs?.private;
    if (!Array.isArray(defaultPrivateDBs)) {
      defaultPrivateDBs = [];
    }
    processUserDBs(defaultPrivateDBs, 'private');
    let defaultSharedDBs = this.config.config.userDBs?.defaultDBs?.shared;
    if (!Array.isArray(defaultSharedDBs)) {
      defaultSharedDBs = [];
    }
    processUserDBs(defaultSharedDBs, 'shared');

    return Promise.all(promises).then(() => {
      return Promise.resolve(newUser);
    });
  }

  /** Cleans up all expired keys from the authentification-DB (`_users`) and superlogin's db. Call this regularily! */
  removeExpiredKeys() {
    return this.#dbAuth.removeExpiredKeys();
  }
}

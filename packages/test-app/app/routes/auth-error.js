import Route from '@ember/routing/route';
import { service } from '@ember/service';

export default class AuthErrorRoute extends Route {
  @service session;
  @service store;

  beforeModel(transition) {
    this.session.requireAuthentication(transition, 'login');
  }

  model() {
    return this.store.findRecord('post', 3);
  }
}

import Route from '@ember/routing/route';
import { service } from '@ember/service';

export default Route.extend({
  store: service(),
  session: service(),

  beforeModel(transition) {
    this.get('session').requireAuthentication(transition, 'login');
  },

  model() {
    return this.get('store').findAll('post');
  },
});

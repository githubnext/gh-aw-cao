export default class NoCachePolicy {
  storable() {
    return false;
  }

  timeToLive() {
    return 0;
  }
}

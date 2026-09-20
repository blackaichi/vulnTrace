"use strict";

const state = { reached: false };

function explode() {
  state.reached = true;
  return "danger#explode";
}

module.exports = { explode, state };

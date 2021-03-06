import { Injectable } from '@angular/core';
import {UtilService} from "./util.service";
import {ApiService} from "./api.service";
import {BigNumber} from 'bignumber.js';
import {AddressBookService} from "./address-book.service";
import * as CryptoJS from 'crypto-js';
import {WorkPoolService} from "./work-pool.service";
import {WebsocketService} from "./websocket.service";
import {NanoBlockService} from "./nano-block.service";
import {NotificationService} from "./notification.service";

export interface WalletAccount {
  id: string;
  frontier: string|null;
  secret: any;
  keyPair: any;
  index: number;
  balance: number|BigNumber;
  pending: number|BigNumber;
  addressBookName: string|null;
}

@Injectable()
export class WalletService {
  walletPassword = '';
  wallet = {
    seedBytes: null,
    seed: '',
    balance: new BigNumber(0),
    pending: new BigNumber(0),
    accounts: [],
    accountsIndex: 0,
    locked: false,
  };

  constructor(private util: UtilService, private api: ApiService, private addressBook: AddressBookService, private workPool: WorkPoolService, private websocket: WebsocketService, private nanoBlock: NanoBlockService, private notifications: NotificationService) {
    this.websocket.newTransactions$.subscribe(async (transaction) => {
      if (!transaction) return; // Not really a new transaction

      // Okay so, find out if this is a send, with our account as a destination or not
      const walletAccountIDs = this.wallet.accounts.map(a => a.id);
      if (transaction.block.type == 'send' && walletAccountIDs.indexOf(transaction.block.destination) !== -1) {
        // Okay we want to perform an automatic receive on this baby

        // We do a receive for the account, it should know if it has txs?
        const walletAccount = this.wallet.accounts.find(a => a.id === transaction.block.destination);
        if (walletAccount) {
          const newHash = await this.nanoBlock.generateReceive(walletAccount, transaction.hash);
          if (newHash) {
            // Can we send notifications from here? sure why not lol
            this.notifications.sendSuccess(`Successfully received Nano!`);
          } else {
            this.notifications.sendError(`There was a problem performing the receive transaction, try manually!`);
          }
        }
      }

      // console.log(`Wallet service, received new transaction!`, transaction);

      // We need an auto accept option, otherwise there is no point

      // transaction.account - the person who initiated the transaction
      // transaction.block.destination - receiver of the block
      // transaction.hash
      // transaction.amount
      // transaction.block.type (send)

      // All we really need is to be able to do a receive on this hash, we dont need the huge shit before

      // TODO: Need function for reloading a specific accounts balance, instead of all of them (Which also fixes the total balance)

      this.reloadBalances();
    })
  }

  async loadStoredWallet() {
    this.resetWallet();

    const walletData = localStorage.getItem('raivault-wallet');
    if (!walletData) return this.wallet;

    const walletJson = JSON.parse(walletData);
    this.wallet.seed = walletJson.seed;
    this.wallet.seedBytes = this.util.hex.toUint8(walletJson.seed);
    this.wallet.locked = walletJson.locked;

    if (this.wallet.locked) {
      return this.wallet; // If the wallet is locked on load, it has to be unlocked before we can load anything?
    }

    this.wallet.accountsIndex = walletJson.accountsIndex;
    await Promise.all(walletJson.accounts.map(async (account) => this.addWalletAccount(account.index, false)));

    await this.reloadBalances();

    if (this.wallet.accounts.length) {
      this.websocket.subscribeAccounts(this.wallet.accounts.map(a => a.id));
    }

    return this.wallet;
  }

  lockWallet() {
    const encryptedSeed = CryptoJS.AES.encrypt(this.wallet.seed, this.walletPassword);

    // Update the seed
    this.wallet.seed = encryptedSeed.toString();
    this.wallet.seedBytes = null;

    // Remove secrets from accounts
    this.wallet.accounts.forEach(a => {
      a.keyPair = null;
      a.secret = null;
    });

    this.wallet.locked = true;

    this.saveWalletExport(); // Save so that a refresh gives you a locked wallet

    return true;
  }
  unlockWallet(password: string) {
    // Find old seed, find new seed?
    try {
      const decryptedBytes = CryptoJS.AES.decrypt(this.wallet.seed, password);
      const decryptedSeed = decryptedBytes.toString(CryptoJS.enc.Utf8);
      if (!decryptedSeed || decryptedSeed.length !== 64) return false;

      this.wallet.seed = decryptedSeed;
      this.wallet.seedBytes = this.util.hex.toUint8(this.wallet.seed);
      this.wallet.accounts.forEach(a => {
        a.secret = this.util.account.generateAccountSecretKeyBytes(this.wallet.seedBytes, a.index);
        a.keyPair = this.util.account.generateAccountKeyPair(a.secret);
      });

      this.wallet.locked = false;

      this.saveWalletExport(); // Save so a refresh also gives you your unlocked wallet?

      return true;
    } catch (err) {
      return false;
    }
  }

  walletIsLocked() {
    return this.wallet.locked;
  }

  createWalletFromSeed(seed: string) {
    this.resetWallet();

    this.wallet.seed = seed;
    this.wallet.seedBytes = this.util.hex.toUint8(seed);

    this.addWalletAccount();

    return this.wallet.seed;
  }

  createNewWallet() {
    this.resetWallet();

    const seedBytes = this.util.account.generateSeedBytes();
    this.wallet.seedBytes = seedBytes;
    this.wallet.seed = this.util.hex.fromUint8(seedBytes);

    this.addWalletAccount();

    return this.wallet.seed;
  }

  /**
   * Reset wallet to a base state, without changing reference to the main object
   */
  resetWallet() {
    this.walletPassword = '';
    this.wallet.locked = false;
    this.wallet.seed = '';
    this.wallet.seedBytes = null;
    this.wallet.accounts = [];
    this.wallet.accountsIndex = 0;
    this.wallet.balance = new BigNumber(0);
    this.wallet.pending = new BigNumber(0);
  }

  async reloadBalances() {
    this.wallet.balance = new BigNumber(0);
    this.wallet.pending = new BigNumber(0);
    const accountIDs = this.wallet.accounts.map(a => a.id);
    const accounts = await this.api.accountsBalances(accountIDs);
    const frontiers = await this.api.accountsFrontiers(accountIDs);

    let walletBalance = new BigNumber(0);
    let walletPending = new BigNumber(0);

    for (let accountID in accounts.balances) {
      if (!accounts.balances.hasOwnProperty(accountID)) continue;
      // Find the account, update it
      const walletAccount = this.wallet.accounts.find(a => a.id == accountID);
      if (!walletAccount) continue;
      walletAccount.balance = new BigNumber(accounts.balances[accountID].balance);
      walletAccount.pending = new BigNumber(accounts.balances[accountID].pending);

      walletAccount.frontier = frontiers.frontiers[accountID] || null;

      walletBalance = walletBalance.plus(walletAccount.balance);
      walletPending = walletPending.plus(walletAccount.pending);
    }

    // Make sure any frontiers are in the work pool
    // If they have no frontier, we want to use their pub key?
    const hashes = this.wallet.accounts.map(account => account.frontier || this.util.account.getAccountPublicKey(account.id));
    hashes.forEach(hash => this.workPool.addToPool(hash));

    this.wallet.balance = walletBalance;
    this.wallet.pending = walletPending;
  }

  async addWalletAccount(accountIndex: number|null = null, reloadBalances: boolean = true) {
    if (!this.wallet.seedBytes) return;
    let index = accountIndex;
    if (index === null) {
      index = this.wallet.accountsIndex; // Use the existing number, then increment it
      this.wallet.accountsIndex += 1;
    }

    const accountBytes = this.util.account.generateAccountSecretKeyBytes(this.wallet.seedBytes, index);
    const accountKeyPair = this.util.account.generateAccountKeyPair(accountBytes);
    const accountName = this.util.account.getPublicAccountID(accountKeyPair.publicKey);
    const addressBookName = this.addressBook.getAccountName(accountName);

    const newAccount: WalletAccount = {
      id: accountName,
      frontier: null,
      secret: accountBytes,
      keyPair: accountKeyPair,
      balance: 0,
      pending: 0,
      index: index,
      addressBookName,
    };

    // Todo, make sure this account isnt already in our list?

    this.wallet.accounts.push(newAccount);

    if (reloadBalances) await this.reloadBalances();

    this.websocket.subscribeAccounts([accountName]);

    this.saveWalletExport();

    return newAccount;
  }

  saveWalletExport() {
    const exportData = this.generateWalletExport();
    localStorage.setItem('raivault-wallet', JSON.stringify(exportData));
  }

  generateWalletExport() {
    const data = {
      seed: this.wallet.seed,
      locked: this.wallet.locked,
      accounts: this.wallet.accounts.map(a => ({ id: a.id, index: a.index })),
      accountsIndex: this.wallet.accountsIndex,
    };

    return data;
  }

}
